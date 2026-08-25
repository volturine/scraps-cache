// Device persistence. IndexedDB is the durable source of truth.
// Every dataset row is namespaced by profile id ("pid"), so several saved sync
// keys coexist on one device and separate windows can work on different
// profiles at the same time without copying data around.

import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { LinkPreview } from '$lib/linkPreview';
import type { Label, Note, NoteImage } from '$lib/types';
import { blobToDataUrl, dataUrlToBlob } from '$lib/imageBlob';

const DB_NAME = 'google-keep-clone';
const DB_VERSION = 8;
export const NOTES_STORE = 'profile-notes';
export const LABELS_STORE = 'profile-labels';
export const IMAGES_STORE = 'profile-images';
const LINK_PREVIEWS_STORE = 'link-previews';
const SYNC_STATE_STORE = 'sync-state';
export const SYNC_OUTBOX_STORE = 'profile-outbox';
export const PROFILES_STORE = 'profiles';

/** Namespace for notes created before any sync key exists. */
export const LOCAL_PROFILE_ID = 'device-local';

/** One saved sync key ("profile") on this device. */
export interface StoredProfile {
	id: string;
	name: string;
	syncKey: string;
	createdAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
const noteChains = new Map<string, Promise<void>>();
// Safari can abort overlapping writes. Keep every write on one device-wide
// chain; noteChains still coalesce rapid writes to the same note before they
// reach it.
let deviceWriteChain: Promise<void> = Promise.resolve();
let writeGeneration = 0;

function enqueueDeviceWrite<T>(operation: () => Promise<T>): Promise<T> {
	const run = deviceWriteChain.catch(() => undefined).then(operation);
	deviceWriteChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

export const DEVICE_DB_NAME = DB_NAME;

// --- Namespaced keys --------------------------------------------------------

/** Row key prefix for a profile inside the shared object stores. */
function ns(pid: string, ...parts: string[]): string {
	return [pid, ...parts].join('::');
}

function profileRange(pid: string): IDBKeyRange {
	return IDBKeyRange.bound(`${pid}::`, `${pid}::￰`, false, false);
}

/** Strip the pid namespace back off an outbox key. */
function stripNs(pid: string, key: string): string {
	return key.startsWith(`${pid}::`) ? key.slice(pid.length + 2) : key;
}

/** Profile-scoped key inside the shared sync-state KV store. */
export function scopedStateKey(base: string, pid: string): string {
	return `${base}:${pid}`;
}

function getDB(): Promise<IDBPDatabase> {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new Error('IndexedDB is not available'));
	}
	if (!dbPromise) {
		dbPromise = openDB(DB_NAME, DB_VERSION, {
			async upgrade(db, oldVersion, _newVersion, tx) {
				if (!db.objectStoreNames.contains(NOTES_STORE)) {
					db.createObjectStore(NOTES_STORE);
				}
				if (!db.objectStoreNames.contains(LABELS_STORE)) {
					db.createObjectStore(LABELS_STORE);
				}
				if (!db.objectStoreNames.contains(IMAGES_STORE)) {
					db.createObjectStore(IMAGES_STORE);
				}
				if (!db.objectStoreNames.contains(LINK_PREVIEWS_STORE)) {
					db.createObjectStore(LINK_PREVIEWS_STORE, { keyPath: 'url' });
				}
				if (!db.objectStoreNames.contains(SYNC_STATE_STORE)) {
					db.createObjectStore(SYNC_STATE_STORE);
				}
				if (!db.objectStoreNames.contains(SYNC_OUTBOX_STORE)) {
					db.createObjectStore(SYNC_OUTBOX_STORE);
				}
				if (!db.objectStoreNames.contains(PROFILES_STORE)) {
					db.createObjectStore(PROFILES_STORE, { keyPath: 'id' });
				}
				// `idb` waits for the returned promise, so the one-time move of
				// pre-profile data runs to completion before any caller sees v8.
				if (oldVersion < 8) await migratePre8Data(db, tx);
			}
		});
	}
	return dbPromise;
}

const LEGACY_SCOPED_KEYS = [
	'gkc-fired-reminders',
	'gkc-idb-note-tombstones',
	'gkc-idb-label-tombstones',
	'gkc-idb-board-tombstones',
	'gkc-idb-kanban-boards'
];

/** Minimal structural view of an object store/transaction for one-off migrations. */
interface LooseCursor {
	key: IDBValidKey;
	value: unknown;
	continue(): Promise<LooseCursor | null>;
}
interface LooseStore {
	openCursor(range?: IDBKeyRange): Promise<LooseCursor | null>;
	put(value: unknown, key?: IDBValidKey): Promise<unknown>;
	get(key: IDBValidKey): Promise<unknown>;
	getAll(): Promise<unknown[]>;
	delete(key: IDBValidKey): Promise<unknown>;
	clear(): Promise<unknown>;
}
interface LooseTx {
	objectStore(name: string): LooseStore;
}

/**
 * One-time move of the pre-profile shared dataset into the namespace of the
 * profile that owned it: the account matching the stored mirror, else the only
 * saved key, else the local no-key namespace. Runs inside the version
 * transaction so it either completes or leaves the old database untouched.
 */
async function migratePre8Data(
	db: {
		deleteObjectStore(name: string): void;
		objectStoreNames: { contains(name: string): boolean };
	},
	tx: LooseTx
): Promise<void> {
	const pid = await legacyOwnerPid(tx);
	const legacyStores = ['notes', 'labels', 'note-images', 'sync-outbox'];
	for (const [from, to] of [
		['notes', NOTES_STORE],
		['labels', LABELS_STORE],
		['note-images', IMAGES_STORE],
		['sync-outbox', SYNC_OUTBOX_STORE]
	]) {
		if (!db.objectStoreNames.contains(from)) continue;
		let cursor = await tx.objectStore(from).openCursor();
		while (cursor) {
			await tx.objectStore(to).put(cursor.value, ns(pid, String(cursor.key)));
			cursor = await cursor.continue();
		}
	}

	const state = tx.objectStore(SYNC_STATE_STORE);
	for (const base of LEGACY_SCOPED_KEYS) {
		const value = await state.get(base);
		if (value === undefined) continue;
		await state.put(value, scopedStateKey(base, pid));
		await state.delete(base);
	}
	if (db.objectStoreNames.contains('profile-stash')) await tx.objectStore('profile-stash').clear();
	for (const name of [...legacyStores, 'profile-stash']) {
		if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
	}
}

/** Which profile namespace inherits the pre-v8 shared dataset. */
async function legacyOwnerPid(tx: LooseTx): Promise<string> {
	const profiles = tx.objectStore(PROFILES_STORE);
	let wantedSyncKey: string | null = null;
	try {
		const raw =
			typeof localStorage !== 'undefined' ? localStorage.getItem('gkc-sync-account') : null;
		const parsed = raw ? (JSON.parse(raw) as { syncKey?: unknown }) : null;
		if (parsed && typeof parsed.syncKey === 'string') wantedSyncKey = parsed.syncKey;
	} catch {
		/* unreadable mirror falls through to first-entry/local */
	}
	const all = (await profiles.getAll()) as Array<{ id?: unknown; syncKey?: unknown }>;
	if (wantedSyncKey) {
		const match = all.find((row) => row.syncKey === wantedSyncKey && typeof row.id === 'string');
		if (match) return String(match.id);
	}
	const first = all.find((row) => typeof row.id === 'string');
	return first ? String(first.id) : LOCAL_PROFILE_ID;
}

/** Drop the cached connection so tests can delete the database between cases. */
export function closeDeviceDatabase(): void {
	const pending = dbPromise;
	dbPromise = null;
	deviceWriteChain = Promise.resolve();
	noteChains.clear();
	writeGeneration = 0;
	outboxGenerationCache = null;
	if (pending)
		void pending.then(
			(db) => db.close(),
			() => undefined
		);
}

// --- Plain-value helpers ----------------------------------------------------

/** Plain clone of an attachment — never hand Svelte proxies to IndexedDB. */
function plainImage(image: NoteImage): NoteImage {
	return {
		id: String(image.id),
		mime: String(image.mime || 'application/octet-stream'),
		dataUrl: typeof image.dataUrl === 'string' ? image.dataUrl : '',
		createdAt: Number(image.createdAt) || 0,
		...(image.name != null && image.name !== '' ? { name: String(image.name) } : {}),
		...(typeof image.thumbUrl === 'string' && image.thumbUrl
			? { thumbUrl: String(image.thumbUrl) }
			: {}),
		...(Number.isFinite(image.width) ? { width: Number(image.width) } : {}),
		...(Number.isFinite(image.height) ? { height: Number(image.height) } : {}),
		...(Number.isFinite(image.byteSize) ? { byteSize: Number(image.byteSize) } : {}),
		...(typeof image.contentHash === 'string' && image.contentHash
			? { contentHash: String(image.contentHash) }
			: {}),
		...(Number.isFinite(image.encodingVersion)
			? { encodingVersion: Number(image.encodingVersion) }
			: {})
	};
}

function plainLinkPreview(preview: LinkPreview): LinkPreview {
	return {
		url: String(preview.url),
		hostname: String(preview.hostname),
		title: String(preview.title),
		...(preview.description ? { description: String(preview.description) } : {}),
		...(preview.image ? { image: String(preview.image) } : {}),
		...(preview.icon ? { icon: String(preview.icon) } : {})
	};
}

/**
 * Fully plain Note for IDB. Spreading `$state` notes leaves nested proxies
 * (labels/images/linkPreviews) which throw DataCloneError on put.
 */
function plainNote(note: Note): Note {
	const images = (note.images ?? []).map(plainImage);
	const linkPreviews = (note.linkPreviews ?? []).map(plainLinkPreview);
	return {
		id: String(note.id),
		title: String(note.title ?? ''),
		body: String(note.body ?? ''),
		color: note.color,
		pinned: Boolean(note.pinned),
		archived: Boolean(note.archived),
		trashed: Boolean(note.trashed),
		trashedAt: note.trashedAt == null ? null : Number(note.trashedAt),
		createdAt: Number(note.createdAt) || 0,
		updatedAt: Number(note.updatedAt) || 0,
		reminder: note.reminder == null ? null : Number(note.reminder),
		labels: Array.from(note.labels ?? [], (id) => String(id)),
		images,
		...(note.fieldTimes ? { fieldTimes: { ...note.fieldTimes } } : {}),
		...(linkPreviews.length ? { linkPreviews } : {})
	};
}

function plainLabel(label: Label): Label {
	return {
		id: String(label.id),
		name: String(label.name),
		createdAt: Number(label.createdAt) || 0,
		updatedAt: Number(label.updatedAt) || Number(label.createdAt) || 0
	};
}

/** Image bytes live in IMAGES_STORE — note rows keep empty dataUrl placeholders + thumbs. */
function detachNote(note: Note): Note {
	const plain = plainNote(note);
	return {
		...plain,
		images: (plain.images ?? []).map((image) => ({
			...image,
			dataUrl: '',
			...(image.thumbUrl ? { thumbUrl: image.thumbUrl } : {})
		}))
	};
}

function bytesFromStored(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
		return Uint8Array.from(value);
	}
	return null;
}

async function blobFromStored(stored: unknown): Promise<Blob | null> {
	if (stored instanceof Blob) return stored;
	if (!stored || typeof stored !== 'object') return null;
	const record = stored as { mime?: unknown; bytes?: unknown; buffer?: unknown };
	const bytes = bytesFromStored(record.bytes) ?? bytesFromStored(record.buffer);
	if (!bytes) return null;
	return new Blob([bytes.slice()], {
		type: typeof record.mime === 'string' ? record.mime : 'application/octet-stream'
	});
}

function imageKey(pid: string, noteId: string, imageId: string): string {
	return `${pid}::${noteId}::${imageId}`;
}

// --- Notes ------------------------------------------------------------------

async function imageFromStoredValue(
	db: IDBPDatabase,
	pid: string,
	noteId: string,
	meta: NoteImage
): Promise<NoteImage | null> {
	if (meta.dataUrl?.length > 20) return plainImage(meta);
	const blob = await blobFromStored(await db.get(IMAGES_STORE, imageKey(pid, noteId, meta.id)));
	if (!blob) {
		// Keep thumb-only metadata so cards still render while full bytes are missing.
		return plainImage({ ...meta, dataUrl: '' });
	}
	return plainImage({
		...meta,
		mime: meta.mime || blob.type,
		dataUrl: await blobToDataUrl(blob)
	});
}

async function hydrateNoteImages(db: IDBPDatabase, pid: string, note: Note): Promise<Note> {
	const images: Array<NoteImage | null> = [];
	for (const meta of note.images ?? []) {
		images.push(await imageFromStoredValue(db, pid, note.id, meta));
	}
	return {
		...plainNote(note),
		images: images.filter((image): image is NoteImage => image !== null)
	};
}

/**
 * Photo bytes land before the note row so a crash still leaves blobs that boot
 * recovery can reattach. Blobs are written one at a time so a multi-image
 * note never holds every converted copy in memory at once.
 */
async function putImageBlobs(db: IDBPDatabase, pid: string, note: Note): Promise<void> {
	for (const image of note.images ?? []) {
		if (!image.dataUrl) continue;
		const blob = await dataUrlToBlob(image.dataUrl);
		const bytes = new Uint8Array(await blob.arrayBuffer());
		await db.put(IMAGES_STORE, { mime: blob.type, bytes }, imageKey(pid, note.id, image.id));
	}
}

async function putNoteSnapshot(
	pid: string,
	note: Note,
	syncOutboxKeys: string[] = []
): Promise<void> {
	// A garbage marker must abort before anything is written so the note row
	// and its outbox entries stay all-or-nothing.
	for (const key of syncOutboxKeys) {
		if (typeof key !== 'string' || !key) throw new Error('Invalid sync outbox key');
	}
	const db = await getDB();
	await putImageBlobs(db, pid, note);
	const previousGeneration = outboxGenerationCache;
	const ownPrefix = `${ns(pid, note.id)}::`;
	const existingKeys = ((await db.getAllKeys(IMAGES_STORE)) as string[]).filter((key) =>
		key.startsWith(ownPrefix)
	);
	const desiredKeys = new Set((note.images ?? []).map((image) => imageKey(pid, note.id, image.id)));
	const lean = detachNote(note);
	const stores = syncOutboxKeys.length
		? [NOTES_STORE, IMAGES_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE]
		: [NOTES_STORE, IMAGES_STORE];
	const tx = db.transaction(stores, 'readwrite');
	try {
		// Metadata-only writes (hydration, a pulled note whose photo has not
		// arrived) must not drop blobs. Clear them when this write has bytes or
		// the note no longer lists any images.
		const incomingHasBytes = (note.images ?? []).some((image) => image.dataUrl);
		if (incomingHasBytes || desiredKeys.size === 0) {
			for (const key of existingKeys) {
				if (!desiredKeys.has(key)) await tx.objectStore(IMAGES_STORE).delete(key);
			}
		}
		await tx.objectStore(NOTES_STORE).put(lean, ns(pid, note.id));
		if (syncOutboxKeys.length) {
			const generation = await nextOutboxGeneration(tx);
			const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
			for (const key of syncOutboxKeys) await outbox.put(generation, ns(pid, key));
		}
		await tx.done;
	} catch (error) {
		try {
			tx.abort();
		} catch {
			// The transaction may already have aborted after a failed request.
		}
		await tx.done.catch(() => undefined);
		outboxGenerationCache = previousGeneration;
		throw error;
	}
}

function enqueueNote<T>(pid: string, noteId: string, operation: () => Promise<T>): Promise<T> {
	const chainKey = ns(pid, noteId);
	const previous = noteChains.get(chainKey) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(operation);
	const completion = run.then(
		() => undefined,
		() => undefined
	);
	noteChains.set(chainKey, completion);
	return run.finally(() => {
		if (noteChains.get(chainKey) === completion) noteChains.delete(chainKey);
	});
}

/** Fast metadata pass: note rows are lean and attachment blobs remain in IDB. */
export async function getAllNotesMetadata(pid: string): Promise<Note[]> {
	const db = await getDB();
	return ((await db.getAll(NOTES_STORE, profileRange(pid))) as Note[]).map(plainNote);
}

/**
 * Image blobs exist only while a note row references them; unreferenced keys
 * can accumulate and are reclaimed here at boot, inside the device write queue.
 */
export function pruneOrphanImageBlobs(pid: string): Promise<void> {
	return enqueueDeviceWrite(async () => {
		const db = await getDB();
		const keys = await db.getAllKeys(IMAGES_STORE, profileRange(pid));
		const notes = (await db.getAll(NOTES_STORE, profileRange(pid))) as Note[];
		const referenced = new Set<string>();
		for (const note of notes) {
			for (const image of note.images ?? []) referenced.add(imageKey(pid, note.id, image.id));
		}
		const orphans = keys.filter((key) => !referenced.has(String(key)));
		if (orphans.length === 0) return;
		const tx = db.transaction(IMAGES_STORE, 'readwrite');
		for (const key of orphans) void tx.objectStore(IMAGES_STORE).delete(key);
		await tx.done;
	});
}

/** Hydrate every attachment for one note. Callers schedule this with bounded concurrency. */
export async function hydrateNoteAttachments(pid: string, note: Note): Promise<Note> {
	const db = await getDB();
	return hydrateNoteImages(db, pid, note);
}

export function putNote(
	pid: string,
	note: Note,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	const snapshot = plainNote(note);
	const outboxKeys = [...new Set(syncOutboxKeys)];
	const generation = writeGeneration;
	return enqueueNote(pid, snapshot.id, () =>
		enqueueDeviceWrite(async () => {
			// A replacement requested after this save owns the final device state.
			if (generation !== writeGeneration) return;
			await putNoteSnapshot(pid, snapshot, outboxKeys);
		})
	);
}

export function deleteNote(pid: string, id: string): Promise<void> {
	const generation = writeGeneration;
	return enqueueNote(pid, id, async () => {
		await enqueueDeviceWrite(async () => {
			if (generation !== writeGeneration) return;
			const db = await getDB();
			const ownPrefix = `${ns(pid, id)}::`;
			const imageKeys = ((await db.getAllKeys(IMAGES_STORE)) as string[]).filter((key) =>
				key.startsWith(ownPrefix)
			);
			const tx = db.transaction([NOTES_STORE, IMAGES_STORE], 'readwrite');
			tx.objectStore(NOTES_STORE).delete(ns(pid, id));
			for (const key of imageKeys) tx.objectStore(IMAGES_STORE).delete(key);
			await tx.done;
		});
	});
}

// --- Labels -----------------------------------------------------------------

export async function getAllLabels(pid: string): Promise<Label[]> {
	const db = await getDB();
	return ((await db.getAll(LABELS_STORE, profileRange(pid))) as Label[]).map(plainLabel);
}

export async function putLabel(
	pid: string,
	label: Label,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	const outboxKeys = [...new Set(syncOutboxKeys)];
	// A garbage marker must abort before anything is written so the label row
	// and its outbox entries stay all-or-nothing.
	for (const key of outboxKeys) {
		if (typeof key !== 'string' || !key) throw new Error('Invalid sync outbox key');
	}
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(
			outboxKeys.length ? [LABELS_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE] : [LABELS_STORE],
			'readwrite'
		);
		try {
			tx.objectStore(LABELS_STORE).put(plainLabel(label), ns(pid, label.id));
			if (outboxKeys.length) {
				const next = await nextOutboxGeneration(tx);
				for (const key of outboxKeys)
					await tx.objectStore(SYNC_OUTBOX_STORE).put(next, ns(pid, key));
			}
			await tx.done;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			throw error;
		}
	});
}

export async function deleteLabel(
	pid: string,
	id: string,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	const outboxKeys = [...new Set(syncOutboxKeys)];
	for (const key of outboxKeys) {
		if (typeof key !== 'string' || !key) throw new Error('Invalid sync outbox key');
	}
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(
			outboxKeys.length ? [LABELS_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE] : [LABELS_STORE],
			'readwrite'
		);
		try {
			tx.objectStore(LABELS_STORE).delete(ns(pid, id));
			if (outboxKeys.length) {
				const next = await nextOutboxGeneration(tx);
				for (const key of outboxKeys)
					await tx.objectStore(SYNC_OUTBOX_STORE).put(next, ns(pid, key));
			}
			await tx.done;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			throw error;
		}
	});
}

/** Delete a label together with its tombstone and upload marker. */
export async function deleteLabelWithTombstone(
	pid: string,
	id: string,
	labelTombstones: Record<string, number>
): Promise<void> {
	const outboxKey = `label-tombstone:${id}`;
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const previousGeneration = outboxGenerationCache;
		const tx = db.transaction([LABELS_STORE, SYNC_STATE_STORE, SYNC_OUTBOX_STORE], 'readwrite');
		try {
			await tx.objectStore(LABELS_STORE).delete(ns(pid, id));
			await tx
				.objectStore(SYNC_STATE_STORE)
				.put(
					Object.fromEntries(Object.entries(labelTombstones).filter(([, at]) => Number(at) > 0)),
					scopedStateKey('gkc-idb-label-tombstones', pid)
				);
			const next = await nextOutboxGeneration(tx);
			await tx.objectStore(SYNC_OUTBOX_STORE).put(next, ns(pid, outboxKey));
			await tx.done;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			outboxGenerationCache = previousGeneration;
			throw error;
		}
	});
}

export async function bulkPutNotes(pid: string, notes: Note[]): Promise<void> {
	for (const note of notes) {
		await putNote(pid, note);
	}
}

export async function bulkPutLabels(pid: string, labels: Label[]): Promise<void> {
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(LABELS_STORE, 'readwrite');
		for (const label of labels) tx.store.put(plainLabel(label), ns(pid, label.id));
		await tx.done;
	});
}

export async function clearAllNotes(pid: string): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction([NOTES_STORE, IMAGES_STORE], 'readwrite');
		tx.objectStore(NOTES_STORE).delete(profileRange(pid));
		tx.objectStore(IMAGES_STORE).delete(profileRange(pid));
		await tx.done;
	});
}

export async function clearAllLabels(pid: string): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.delete(LABELS_STORE, profileRange(pid));
	});
}

/**
 * Replace one profile's records as one exclusive write operation (pairing
 * "discard local" and backup imports). The write gate prevents an earlier
 * seed/autosave from committing after the clear.
 */
export function replaceAllDeviceData(
	pid: string,
	notes: Note[],
	labels: Label[],
	onNoteCommitted?: (note: Note) => void | Promise<void>
): Promise<void> {
	const generation = ++writeGeneration;
	return enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const clear = db.transaction([NOTES_STORE, IMAGES_STORE, LABELS_STORE], 'readwrite');
		clear.objectStore(NOTES_STORE).delete(profileRange(pid));
		clear.objectStore(IMAGES_STORE).delete(profileRange(pid));
		clear.objectStore(LABELS_STORE).delete(profileRange(pid));
		await clear.done;
		let firstError: unknown = null;
		for (const note of notes) {
			try {
				await putNoteSnapshot(pid, plainNote(note));
				// Release each downloaded full-resolution data URL immediately after
				// its Blob transaction is durable; a fresh iPhone must not retain the
				// full account while the rest of the replacement is still writing.
				await onNoteCommitted?.(note);
			} catch (error) {
				// Keep writing the remaining notes so an abort on one image (quota,
				// Safari pressure) cannot leave the profile half-replaced.
				firstError ??= error;
			}
		}
		const labelWrite = db.transaction(LABELS_STORE, 'readwrite');
		for (const label of labels) labelWrite.store.put(plainLabel(label), ns(pid, label.id));
		await labelWrite.done;
		if (firstError) throw firstError;
	});
}

// --- Link previews (shared cache, not profile-scoped) -----------------------

export async function getCachedLinkPreview(url: string): Promise<LinkPreview | undefined> {
	const db = await getDB();
	const row = await db.get(LINK_PREVIEWS_STORE, url);
	if (!row || typeof row !== 'object') return undefined;
	const { url: cachedUrl, hostname, title, description, image, icon } = row as LinkPreview;
	if (typeof cachedUrl !== 'string' || typeof hostname !== 'string' || typeof title !== 'string')
		return undefined;
	return plainLinkPreview({
		url: cachedUrl,
		hostname,
		title,
		...(typeof description === 'string' ? { description } : {}),
		...(typeof image === 'string' ? { image } : {}),
		...(typeof icon === 'string' ? { icon } : {})
	});
}

export async function putCachedLinkPreview(preview: LinkPreview): Promise<void> {
	const db = await getDB();
	await db.put(LINK_PREVIEWS_STORE, {
		...plainLinkPreview(preview),
		fetchedAt: Date.now()
	});
}

// --- Sync-state KV ----------------------------------------------------------

/** Durable sync cursor/baseline state. Unlike localStorage, this is not size-limited. */
export async function getSyncState<T>(key: string): Promise<T | undefined> {
	const db = await getDB();
	return (await db.get(SYNC_STATE_STORE, key)) as T | undefined;
}

export async function setSyncState<T>(key: string, value: T): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.put(SYNC_STATE_STORE, value, key);
	});
}

export async function deleteSyncState(key: string): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.delete(SYNC_STATE_STORE, key);
	});
}

const FIRED_REMINDERS_KEY = 'gkc-fired-reminders';

export async function getFiredReminderKeys(pid: string): Promise<string[]> {
	const stored = await getSyncState<unknown>(scopedStateKey(FIRED_REMINDERS_KEY, pid));
	if (!Array.isArray(stored)) return [];
	return stored.filter((item): item is string => typeof item === 'string');
}

export async function setFiredReminderKeys(pid: string, keys: Iterable<string>): Promise<void> {
	await setSyncState(scopedStateKey(FIRED_REMINDERS_KEY, pid), [...keys]);
}

/** Atomically claim a wake for delivery. Returns false when another context already claimed it. */
export async function claimFiredReminderKey(pid: string, key: string): Promise<boolean> {
	return enqueueDeviceWrite(async () => {
		const db = await getDB();
		const storeKey = scopedStateKey(FIRED_REMINDERS_KEY, pid);
		const tx = db.transaction(SYNC_STATE_STORE, 'readwrite');
		const stored = await tx.store.get(storeKey);
		const keys = new Set(
			Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
		);
		if (keys.has(key)) {
			await tx.done;
			return false;
		}
		keys.add(key);
		await tx.store.put([...keys], storeKey);
		await tx.done;
		return true;
	});
}

// --- Outbox -----------------------------------------------------------------

/**
 * Outbox generations are a persisted monotonic counter seeded from the wall
 * clock. Timestamps alone break under backward clock jumps: a marker stamped
 * after a sync snapshot could sort below it and get acknowledged without its
 * content ever uploading.
 */
const OUTBOX_GENERATION_KEY = 'gkc-outbox-generation';
let outboxGenerationCache: number | null = null;

async function loadOutboxGeneration(db: IDBPDatabase): Promise<number> {
	if (outboxGenerationCache == null) {
		outboxGenerationCache = Number((await db.get(SYNC_STATE_STORE, OUTBOX_GENERATION_KEY)) ?? 0);
	}
	return outboxGenerationCache;
}

/** Allocate the next generation inside the caller's transaction. */
async function nextOutboxGeneration(
	tx: IDBPTransaction<unknown, string[], 'readwrite'>
): Promise<number> {
	if (outboxGenerationCache == null) {
		outboxGenerationCache = Number(
			(await tx.objectStore(SYNC_STATE_STORE).get(OUTBOX_GENERATION_KEY)) ?? 0
		);
	}
	const generation = Math.max(Date.now(), outboxGenerationCache + 1);
	outboxGenerationCache = generation;
	await tx.objectStore(SYNC_STATE_STORE).put(generation, OUTBOX_GENERATION_KEY);
	return generation;
}

/** Highest generation allocated so far; sync runs acknowledge up to this snapshot. */
export function getOutboxGeneration(): Promise<number> {
	return enqueueDeviceWrite(async () => loadOutboxGeneration(await getDB()));
}

/** Durable set of plaintext-local record keys awaiting encrypted upload. Returns its generation. */
export async function markSyncOutbox(pid: string, keys: Iterable<string>): Promise<number> {
	const unique = [...new Set(keys)].filter(Boolean);
	if (unique.length === 0) return 0;
	return enqueueDeviceWrite(async () => {
		const db = await getDB();
		const previousGeneration = outboxGenerationCache;
		const tx = db.transaction([SYNC_STATE_STORE, SYNC_OUTBOX_STORE], 'readwrite');
		try {
			const generation = await nextOutboxGeneration(tx);
			const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
			for (const key of unique) await outbox.put(generation, ns(pid, key));
			await tx.done;
			return generation;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			outboxGenerationCache = previousGeneration;
			throw error;
		}
	});
}

export async function getSyncOutboxKeys(pid: string): Promise<string[]> {
	const db = await getDB();
	const keys = await db.getAllKeys(SYNC_OUTBOX_STORE, profileRange(pid));
	return keys.map((key) => stripNs(pid, String(key)));
}

export async function clearSyncOutbox(
	pid: string,
	keys: Iterable<string>,
	through = Number.POSITIVE_INFINITY
): Promise<void> {
	const unique = [...new Set(keys)].filter(Boolean);
	if (unique.length === 0) return;
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction(SYNC_OUTBOX_STORE, 'readwrite');
		for (const key of unique) {
			const namespaced = ns(pid, key);
			const markedAt = Number(await tx.store.get(namespaced));
			if (markedAt > 0 && markedAt <= through) await tx.store.delete(namespaced);
		}
		await tx.done;
	});
}

/** Commit the durable cursor/baseline and acknowledge their outbox generation together. */
export async function commitSyncControl(
	pid: string,
	state: Iterable<readonly [key: string, value: unknown]>,
	acknowledgements: Iterable<{ keys: Iterable<string>; through: number }>
): Promise<void> {
	const entries = [...state];
	const acknowledged = [...acknowledgements].map(({ keys, through }) => ({
		keys: [...new Set(keys)].filter(Boolean),
		through
	}));
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction([SYNC_STATE_STORE, SYNC_OUTBOX_STORE], 'readwrite');
		try {
			const syncState = tx.objectStore(SYNC_STATE_STORE);
			const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
			for (const [key, value] of entries) await syncState.put(value, key);
			for (const { keys, through } of acknowledged) {
				for (const key of keys) {
					const namespaced = ns(pid, key);
					const markedAt = Number(await outbox.get(namespaced));
					if (markedAt > 0 && markedAt <= through) await outbox.delete(namespaced);
				}
			}
			await tx.done;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			throw error;
		}
	});
}

// --- Profiles (saved sync keys) --------------------------------------------

function isStoredProfile(value: unknown): value is StoredProfile {
	if (!value || typeof value !== 'object') return false;
	const row = value as Partial<StoredProfile>;
	return (
		typeof row.id === 'string' &&
		row.id.length > 0 &&
		typeof row.name === 'string' &&
		typeof row.syncKey === 'string' &&
		row.syncKey.length > 0 &&
		Number.isFinite(row.createdAt)
	);
}

export async function listStoredProfiles(): Promise<StoredProfile[]> {
	const db = await getDB();
	return (await db.getAll(PROFILES_STORE)).filter(isStoredProfile);
}

export async function putStoredProfile(profile: StoredProfile): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.put(PROFILES_STORE, { ...profile });
	});
}

/** Removes the keyring entry together with its entire dataset namespace. */
export async function deleteStoredProfile(id: string): Promise<void> {
	const generation = ++writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(
			[PROFILES_STORE, NOTES_STORE, LABELS_STORE, IMAGES_STORE, SYNC_OUTBOX_STORE],
			'readwrite'
		);
		tx.objectStore(PROFILES_STORE).delete(id);
		const range = profileRange(id);
		tx.objectStore(NOTES_STORE).delete(range);
		tx.objectStore(LABELS_STORE).delete(range);
		tx.objectStore(IMAGES_STORE).delete(range);
		tx.objectStore(SYNC_OUTBOX_STORE).delete(range);
		await tx.done;
		const state = db.transaction(SYNC_STATE_STORE, 'readwrite');
		for (const base of LEGACY_SCOPED_KEYS) await state.store.delete(scopedStateKey(base, id));
		await state.done;
	});
}

/** Approximate on-device footprint of one profile's namespace, in bytes. */
export async function estimateProfileBytes(pid: string): Promise<number> {
	const db = await getDB();
	const [notes, labels, images] = await Promise.all([
		db.getAll(NOTES_STORE, profileRange(pid)),
		db.getAll(LABELS_STORE, profileRange(pid)),
		db.getAll(IMAGES_STORE, profileRange(pid))
	]);
	let total = 0;
	for (const row of labels) total += JSON.stringify(row).length;
	for (const row of images) {
		const bytes = bytesFromStored((row as { bytes?: unknown }).bytes);
		total += (bytes?.length ?? 0) + 32;
	}
	for (const row of notes) {
		const noteRow = row as Note;
		// Lean rows keep thumbnails inline; full photo bytes live above.
		const withoutThumbs = {
			...noteRow,
			images: (noteRow.images ?? []).map(({ thumbUrl: _t, ...image }) => image)
		};
		total += JSON.stringify(withoutThumbs).length;
	}
	return total;
}

/**
 * Persist boards, their tombstones, and pending upload markers in one
 * transaction so a crash can never change board state without its markers.
 */
export async function writeKanbanState(
	pid: string,
	boards: unknown,
	boardTombstones: Record<string, number>,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	const outboxKeys = [...new Set(syncOutboxKeys)].filter(Boolean);
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction([SYNC_STATE_STORE, SYNC_OUTBOX_STORE], 'readwrite');
		const state = tx.objectStore(SYNC_STATE_STORE);
		const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
		try {
			state.put(
				JSON.parse(JSON.stringify(boards ?? [])),
				scopedStateKey('gkc-idb-kanban-boards', pid)
			);
			state.put(
				Object.fromEntries(
					Object.entries(boardTombstones ?? {}).filter(([, at]) => Number(at) > 0)
				),
				scopedStateKey('gkc-idb-board-tombstones', pid)
			);
			if (outboxKeys.length) {
				const next = await nextOutboxGeneration(tx);
				for (const key of outboxKeys) await outbox.put(next, ns(pid, key));
			}
			await tx.done;
		} catch (error) {
			try {
				tx.abort();
			} catch {
				// The transaction may already have aborted after a failed request.
			}
			await tx.done.catch(() => undefined);
			throw error;
		}
	});
}

/**
 * Whether a namespace holds any profile data at all: notes, labels, photo
 * blobs, pending uploads, delete manifests, boards, or reminder keys. Used to
 * rescue stranded pre-namespacing datasets of every shape.
 */
export async function namespaceHasData(pid: string): Promise<boolean> {
	const db = await getDB();
	const range = profileRange(pid);
	const [noteCount, labelCount, imageCount, outboxCount] = await Promise.all([
		db.count(NOTES_STORE, range),
		db.count(LABELS_STORE, range),
		db.count(IMAGES_STORE, range),
		db.count(SYNC_OUTBOX_STORE, range)
	]);
	if (noteCount || labelCount || imageCount || outboxCount) return true;
	for (const base of LEGACY_SCOPED_KEYS) {
		if ((await db.get(SYNC_STATE_STORE, scopedStateKey(base, pid))) !== undefined) return true;
	}
	return false;
}

/** Hand ownership of one namespace's rows to another (used when the first sync
 * key is created or paired on a device that had local no-account data).
 * Tombstones, boards, and reminder keys move across as part of the dataset. */
export async function copyProfileNamespace(fromPid: string, toPid: string): Promise<void> {
	if (fromPid === toPid) return;
	const generation = ++writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(
			[NOTES_STORE, LABELS_STORE, IMAGES_STORE, SYNC_OUTBOX_STORE, SYNC_STATE_STORE],
			'readwrite'
		);
		const loose = (name: string): LooseStore => tx.objectStore(name) as unknown as LooseStore;
		const range = profileRange(fromPid);
		for (const storeName of [NOTES_STORE, LABELS_STORE, IMAGES_STORE, SYNC_OUTBOX_STORE]) {
			const source = loose(storeName);
			let cursor = await source.openCursor(range);
			while (cursor) {
				await loose(storeName).put(
					cursor.value,
					ns(toPid, String(cursor.key).slice(fromPid.length + 2))
				);
				cursor = await cursor.continue();
			}
		}
		const state = loose(SYNC_STATE_STORE);
		for (const base of LEGACY_SCOPED_KEYS) {
			const value = await state.get(scopedStateKey(base, fromPid));
			if (value === undefined) continue;
			await state.put(value, scopedStateKey(base, toPid));
		}
		await tx.done;
	});
}

/**
 * Relocate a whole namespace: copy rows and profile-scoped state keys to the
 * target pid, then remove the source. Used when signing out so the promised
 * "notes on this device are kept" survive under the local namespace.
 */
export async function unlinkProfileToNamespace(fromPid: string, toPid: string): Promise<void> {
	if (fromPid === toPid) return;
	++writeGeneration;
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction(
			[
				PROFILES_STORE,
				NOTES_STORE,
				LABELS_STORE,
				IMAGES_STORE,
				SYNC_OUTBOX_STORE,
				SYNC_STATE_STORE
			],
			'readwrite'
		);
		const loose = (name: string): LooseStore => tx.objectStore(name) as unknown as LooseStore;
		const range = profileRange(fromPid);
		for (const storeName of [NOTES_STORE, LABELS_STORE, IMAGES_STORE, SYNC_OUTBOX_STORE]) {
			const source = loose(storeName);
			let cursor = await source.openCursor(range);
			while (cursor) {
				await loose(storeName).put(
					cursor.value,
					ns(toPid, String(cursor.key).slice(fromPid.length + 2))
				);
				cursor = await cursor.continue();
			}
			tx.objectStore(storeName).delete(range);
		}
		const state = loose(SYNC_STATE_STORE);
		for (const base of LEGACY_SCOPED_KEYS) {
			const sourceKey = scopedStateKey(base, fromPid);
			const value = await state.get(sourceKey);
			if (value !== undefined) await state.put(value, scopedStateKey(base, toPid));
			await state.delete(sourceKey);
		}
		await loose(PROFILES_STORE).delete(fromPid);
		await tx.done;
	});
}
