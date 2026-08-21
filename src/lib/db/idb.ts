// Device persistence. IndexedDB is the durable source of truth; localStorage is handled
// separately as a blob-free fast-boot mirror by noteStorage.ts.

import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { LinkPreview } from '$lib/linkPreview';
import type { Label, Note, NoteImage } from '$lib/types';
import { blobToDataUrl, dataUrlToBlob } from '$lib/imageBlob';

const DB_NAME = 'google-keep-clone';
const DB_VERSION = 6;
const NOTES_STORE = 'notes';
const LABELS_STORE = 'labels';
const IMAGES_STORE = 'note-images';
const LINK_PREVIEWS_STORE = 'link-previews';
const SYNC_STATE_STORE = 'sync-state';
const SYNC_OUTBOX_STORE = 'sync-outbox';

let dbPromise: Promise<IDBPDatabase> | null = null;
const noteChains = new Map<string, Promise<void>>();
// Safari can abort overlapping writes while a fresh-device replacement clears
// the stores. Keep every write on one device-wide chain; noteChains still
// coalesce rapid writes to the same note before they reach it.
let deviceWriteChain: Promise<void> = Promise.resolve();
let writeGeneration = 0;

function imageKey(noteId: string, imageId: string): string {
	return `${noteId}::${imageId}`;
}

function enqueueDeviceWrite<T>(operation: () => Promise<T>): Promise<T> {
	const run = deviceWriteChain.catch(() => undefined).then(operation);
	deviceWriteChain = run.then(
		() => undefined,
		() => undefined
	);
	return run;
}

export const DEVICE_DB_NAME = DB_NAME;

function getDB(): Promise<IDBPDatabase> {
	if (typeof indexedDB === 'undefined') {
		return Promise.reject(new Error('IndexedDB is not available'));
	}
	if (!dbPromise) {
		dbPromise = openDB(DB_NAME, DB_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(NOTES_STORE)) {
					db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
				}
				if (!db.objectStoreNames.contains(LABELS_STORE)) {
					db.createObjectStore(LABELS_STORE, { keyPath: 'id' });
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
			}
		});
	}
	return dbPromise;
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

/** Plain, validated data only: never hand Svelte proxies to IndexedDB.
 *  Image bytes live in IMAGES_STORE — note rows keep empty dataUrl placeholders + thumbs. */
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

function snapshotNote(note: Note): Note {
	return plainNote(note);
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

async function imageFromStoredValue(
	db: IDBPDatabase,
	noteId: string,
	meta: NoteImage
): Promise<NoteImage | null> {
	if (meta.dataUrl?.length > 20) return plainImage(meta);
	const blob = await blobFromStored(await db.get(IMAGES_STORE, imageKey(noteId, meta.id)));
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

async function hydrateNoteImages(db: IDBPDatabase, note: Note): Promise<Note> {
	const images: Array<NoteImage | null> = [];
	for (const meta of note.images ?? []) {
		images.push(await imageFromStoredValue(db, note.id, meta));
	}
	return {
		...plainNote(note),
		images: images.filter((image): image is NoteImage => image !== null)
	};
}

async function prepareImageBlobs(note: Note): Promise<Array<{ key: string; blob: Blob }>> {
	const entries: Array<{ key: string; blob: Blob }> = [];
	for (const image of note.images ?? []) {
		if (!image.dataUrl) continue;
		entries.push({ key: imageKey(note.id, image.id), blob: await dataUrlToBlob(image.dataUrl) });
	}
	return entries;
}

/**
 * Photo bytes land first so a crash before the note-row commit still leaves
 * blobs that boot recovery can reattach from mirrored image ids.
 */
async function putNoteSnapshot(note: Note, syncOutboxKeys: string[] = []): Promise<void> {
	const db = await getDB();
	const blobs = await prepareImageBlobs(note);
	for (const { key, blob } of blobs) {
		await db.put(
			IMAGES_STORE,
			{ mime: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) },
			key
		);
	}
	const existingKeys = (await db.getAllKeys(IMAGES_STORE)).filter((key) =>
		String(key).startsWith(`${note.id}::`)
	);
	const desiredKeys = new Set((note.images ?? []).map((image) => imageKey(note.id, image.id)));
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
				if (!desiredKeys.has(String(key))) await tx.objectStore(IMAGES_STORE).delete(key);
			}
		}
		await tx.objectStore(NOTES_STORE).put(lean);
		if (syncOutboxKeys.length) {
			const generation = await nextOutboxGeneration(tx);
			const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
			for (const key of syncOutboxKeys) await outbox.put(generation, key);
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
}

function enqueueNote<T>(noteId: string, operation: () => Promise<T>): Promise<T> {
	const previous = noteChains.get(noteId) ?? Promise.resolve();
	const run = previous.catch(() => undefined).then(operation);
	const completion = run.then(
		() => undefined,
		() => undefined
	);
	noteChains.set(noteId, completion);
	return run.finally(() => {
		if (noteChains.get(noteId) === completion) noteChains.delete(noteId);
	});
}

/** Fast metadata pass: note rows are lean and attachment blobs remain in IDB. */
export async function getAllNotesMetadata(): Promise<Note[]> {
	const db = await getDB();
	return ((await db.getAll(NOTES_STORE)) as Note[]).map(plainNote);
}

/**
 * Image blobs exist only while a note row references them. Writes land bytes
 * before the row (crash safety) and metadata-only writes keep existing blobs,
 * so unreferenced keys can accumulate; ownership is reclaimed at boot. Runs
 * inside the device write queue so it cannot observe a half-committed write.
 */
export function pruneOrphanImageBlobs(): Promise<void> {
	return enqueueDeviceWrite(async () => {
		const db = await getDB();
		const [keys, notes] = await Promise.all([
			db.getAllKeys(IMAGES_STORE),
			db.getAll(NOTES_STORE) as Promise<Note[]>
		]);
		const referenced = new Set<string>();
		for (const note of notes) {
			for (const image of note.images ?? []) referenced.add(imageKey(note.id, image.id));
		}
		const orphans = keys.filter((key) => !referenced.has(String(key)));
		if (orphans.length === 0) return;
		const tx = db.transaction(IMAGES_STORE, 'readwrite');
		for (const key of orphans) void tx.objectStore(IMAGES_STORE).delete(key);
		await tx.done;
	});
}

/** Hydrate every attachment for one note. Callers schedule this with bounded concurrency. */
export async function hydrateNoteAttachments(note: Note): Promise<Note> {
	const db = await getDB();
	return hydrateNoteImages(db, note);
}

/** Legacy full-read helper for callers that explicitly need all attachment bytes now. */
export async function getAllNotes(): Promise<Note[]> {
	const notes = await getAllNotesMetadata();
	const hydrated: Note[] = [];
	for (const note of notes) hydrated.push(await hydrateNoteAttachments(note));
	return hydrated;
}

export function putNote(note: Note, syncOutboxKeys: Iterable<string> = []): Promise<void> {
	const snapshot = snapshotNote(note);
	const outboxKeys = [...new Set(syncOutboxKeys)];
	const generation = writeGeneration;
	return enqueueNote(snapshot.id, () =>
		enqueueDeviceWrite(async () => {
			// A replacement requested after this save owns the final device state.
			if (generation !== writeGeneration) return;
			await putNoteSnapshot(snapshot, outboxKeys);
		})
	);
}

export function deleteNote(id: string): Promise<void> {
	const generation = writeGeneration;
	return enqueueNote(id, async () => {
		await enqueueDeviceWrite(async () => {
			if (generation !== writeGeneration) return;
			const db = await getDB();
			const imageKeys = (await db.getAllKeys(IMAGES_STORE)).filter((key) =>
				String(key).startsWith(`${id}::`)
			);
			const tx = db.transaction([NOTES_STORE, IMAGES_STORE], 'readwrite');
			tx.objectStore(NOTES_STORE).delete(id);
			for (const key of imageKeys) tx.objectStore(IMAGES_STORE).delete(key);
			await tx.done;
		});
	});
}

export async function getAllLabels(): Promise<Label[]> {
	const db = await getDB();
	return (await db.getAll(LABELS_STORE)) as Label[];
}

export async function putLabel(label: Label): Promise<void> {
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		await db.put(LABELS_STORE, {
			id: String(label.id),
			name: String(label.name),
			createdAt: Number(label.createdAt) || 0,
			updatedAt: Number(label.updatedAt) || Number(label.createdAt) || 0
		});
	});
}

export async function deleteLabel(id: string): Promise<void> {
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		await db.delete(LABELS_STORE, id);
	});
}

export async function bulkPutNotes(notes: Note[]): Promise<void> {
	for (const note of notes) {
		await putNote(note);
	}
}

export async function bulkPutLabels(labels: Label[]): Promise<void> {
	const generation = writeGeneration;
	await enqueueDeviceWrite(async () => {
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const tx = db.transaction(LABELS_STORE, 'readwrite');
		for (const label of labels) {
			tx.store.put({
				id: String(label.id),
				name: String(label.name),
				createdAt: Number(label.createdAt) || 0,
				updatedAt: Number(label.updatedAt) || Number(label.createdAt) || 0
			});
		}
		await tx.done;
	});
}

export async function clearAllNotes(): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction([NOTES_STORE, IMAGES_STORE], 'readwrite');
		tx.objectStore(NOTES_STORE).clear();
		tx.objectStore(IMAGES_STORE).clear();
		await tx.done;
	});
}

export async function clearAllLabels(): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.clear(LABELS_STORE);
	});
}

/**
 * Replace a newly linked device's records as one exclusive write operation.
 * The per-note Blob commits stay short for iOS Safari, while the write gate
 * prevents an earlier seed/autosave from committing after the clear.
 */
export function replaceAllDeviceData(
	notes: Note[],
	labels: Label[],
	onNoteCommitted?: (note: Note) => void | Promise<void>
): Promise<void> {
	const generation = ++writeGeneration;
	const labelSnapshots = labels.map((label) => ({
		id: String(label.id),
		name: String(label.name),
		createdAt: Number(label.createdAt) || 0,
		updatedAt: Number(label.updatedAt) || Number(label.createdAt) || 0
	}));
	return enqueueDeviceWrite(async () => {
		// A later replacement supersedes this one before it touches storage.
		if (generation !== writeGeneration) return;
		const db = await getDB();
		const clear = db.transaction([NOTES_STORE, IMAGES_STORE, LABELS_STORE], 'readwrite');
		clear.objectStore(NOTES_STORE).clear();
		clear.objectStore(IMAGES_STORE).clear();
		clear.objectStore(LABELS_STORE).clear();
		await clear.done;
		for (const note of notes) {
			await putNoteSnapshot(snapshotNote(note));
			// Release each downloaded full-resolution data URL immediately after its
			// Blob transaction is durable; a fresh iPhone must not retain the full
			// account while the rest of the replacement is still writing.
			await onNoteCommitted?.(note);
		}
		const labelWrite = db.transaction(LABELS_STORE, 'readwrite');
		for (const label of labelSnapshots) labelWrite.store.put(label);
		await labelWrite.done;
	});
}

/** Shared link-preview cache: one fetch per URL, reused across notes. */
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

export async function getAllCachedLinkPreviews(): Promise<LinkPreview[]> {
	const db = await getDB();
	const rows = await db.getAll(LINK_PREVIEWS_STORE);
	return rows.flatMap((row) => {
		if (!row || typeof row !== 'object') return [];
		const { url, hostname, title, description, image, icon } = row as LinkPreview;
		if (typeof url !== 'string' || typeof hostname !== 'string' || typeof title !== 'string')
			return [];
		return [
			plainLinkPreview({
				url,
				hostname,
				title,
				...(typeof description === 'string' ? { description } : {}),
				...(typeof image === 'string' ? { image } : {}),
				...(typeof icon === 'string' ? { icon } : {})
			})
		];
	});
}

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

const FIRED_REMINDERS_KEY = 'gkc-fired-reminders';

export async function getFiredReminderKeys(): Promise<string[]> {
	const stored = await getSyncState<unknown>(FIRED_REMINDERS_KEY);
	if (!Array.isArray(stored)) return [];
	return stored.filter((item): item is string => typeof item === 'string');
}

export async function setFiredReminderKeys(keys: Iterable<string>): Promise<void> {
	await setSyncState(FIRED_REMINDERS_KEY, [...keys]);
}

/** Merge one delivered wake atomically so pages and the service worker cannot lose each other's ids. */
export async function markFiredReminderKey(key: string): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction(SYNC_STATE_STORE, 'readwrite');
		const stored = await tx.store.get(FIRED_REMINDERS_KEY);
		const keys = new Set(
			Array.isArray(stored) ? stored.filter((item): item is string => typeof item === 'string') : []
		);
		keys.add(key);
		await tx.store.put([...keys], FIRED_REMINDERS_KEY);
		await tx.done;
	});
}

export async function deleteSyncState(key: string): Promise<void> {
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		await db.delete(SYNC_STATE_STORE, key);
	});
}

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
export async function markSyncOutbox(keys: Iterable<string>): Promise<number> {
	const unique = [...new Set(keys)].filter(Boolean);
	if (unique.length === 0) return 0;
	return enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction([SYNC_STATE_STORE, SYNC_OUTBOX_STORE], 'readwrite');
		try {
			const generation = await nextOutboxGeneration(tx);
			const outbox = tx.objectStore(SYNC_OUTBOX_STORE);
			for (const key of unique) await outbox.put(generation, key);
			await tx.done;
			return generation;
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

export async function getSyncOutboxKeys(): Promise<string[]> {
	const db = await getDB();
	return (await db.getAllKeys(SYNC_OUTBOX_STORE)).map(String);
}

export async function clearSyncOutbox(
	keys: Iterable<string>,
	through = Number.POSITIVE_INFINITY
): Promise<void> {
	const unique = [...new Set(keys)].filter(Boolean);
	if (unique.length === 0) return;
	await enqueueDeviceWrite(async () => {
		const db = await getDB();
		const tx = db.transaction(SYNC_OUTBOX_STORE, 'readwrite');
		for (const key of unique) {
			const markedAt = Number(await tx.store.get(key));
			if (markedAt > 0 && markedAt <= through) await tx.store.delete(key);
		}
		await tx.done;
	});
}

/** Commit the durable cursor/baseline and acknowledge their outbox generation together. */
export async function commitSyncControl(
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
					const markedAt = Number(await outbox.get(key));
					if (markedAt > 0 && markedAt <= through) await outbox.delete(key);
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
