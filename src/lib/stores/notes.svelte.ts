// Rune-based notes & labels store. Persists to IndexedDB via $effect.
import type { Note, Label, NoteColor, NoteField } from '$lib/types';
import {
	getAllNotesMetadata,
	hydrateNoteAttachments,
	putNote,
	deleteNote,
	getAllLabels,
	putLabel,
	deleteLabel,
	bulkPutNotes,
	bulkPutLabels,
	clearAllNotes,
	clearAllLabels,
	replaceAllDeviceData,
	getSyncOutboxKeys,
	clearSyncOutbox,
	pruneOrphanImageBlobs
} from '$lib/db/idb';
import {
	mergeLabelLists,
	mergeNoteLists,
	retargetLocalNotes,
	touchNoteFields,
	withoutTombstoned
} from '$lib/noteMerge';
import { mergeHydratedImages } from '$lib/noteAttachmentHydration';
import { AttachmentHydrationQueue } from '$lib/attachmentHydrationQueue';
import { syncStore, type SyncSnapshot } from '$lib/stores/sync.svelte';
import { kanbanStore } from '$lib/stores/kanban.svelte';
import { uiStore } from '$lib/stores/ui.svelte';
import { uid, daysSinceTrashed, TRASH_PURGE_DAYS, cloneNote } from '$lib/utils';
import { noteAttachments, toggleLineAt } from '$lib/checklistBody';
import {
	readLabelsMirror,
	readNotesMirror,
	writeLabelsMirror,
	writeNotesMirror
} from '$lib/noteStorage';
import {
	hydrateTombstones,
	readLabelTombstones,
	readTombstones,
	writeLabelTombstones,
	writeTombstones
} from '$lib/syncTombstones';
import { stripFullImageBytes } from '$lib/noteImages';
import { makeImageThumbDataUrl } from '$lib/imageThumb';
import { replacementFitsStorage } from '$lib/storageCapacity';
import { formatStorageError } from '$lib/imageBlob';
import type { NoteImage } from '$lib/types';
import { normalizeBackup, type BackupImportProgress, type ScrapsCacheBackup } from '$lib/backup';
import { stableStringify } from '$lib/syncHash';

/** Minimum gap between opportunistic auto syncs; manual syncs are never throttled. */
const AUTO_SYNC_MIN_INTERVAL_MS = 30_000;

function durableNoteSignature(note: Note): string {
	return stableStringify({
		...note,
		images: (note.images ?? []).map(({ dataUrl: _dataUrl, thumbUrl: _thumbUrl, ...image }) => image)
	});
}

export function noteNeedsDurableWrite(current: Note | undefined, candidate: Note): boolean {
	if (!current || durableNoteSignature(current) !== durableNoteSignature(candidate)) return true;
	const currentImages = new Map((current.images ?? []).map((image) => [image.id, image]));
	return (candidate.images ?? []).some((image) => {
		const previous = currentImages.get(image.id);
		return (
			image.dataUrl.length > 0 && (!previous || (!previous.dataUrl.length && !previous.thumbUrl))
		);
	});
}

/** True when closing the editor should throw the note away. */
export function noteIsBlank(note: Note): boolean {
	return (
		!note.title.trim() &&
		!(note.body ?? '').trim() &&
		note.reminder == null &&
		!noteAttachments(note).some((attachment) => attachment.dataUrl.length > 0)
	);
}

function noteSyncKeys(note: Note): string[] {
	return [`note:${note.id}`, ...(note.images ?? []).map((image) => `attachment:${image.id}`)];
}

export class NotesStore {
	notes = $state<Note[]>([]);
	labels = $state<Label[]>([]);
	loaded = $state(false);
	lastPersistError = $state<string | null>(null);
	backupImportProgress = $state<BackupImportProgress | null>(null);
	deletedNoteIds = $state<Record<string, number>>(readTombstones());
	deletedLabelIds = $state<Record<string, number>>(readLabelTombstones());
	private attachmentLoads = new Map<string, Promise<void>>();
	private attachmentPass: Promise<void> | null = null;
	private lastAutoSyncAt = 0;
	private visibleAttachmentQueue = new AttachmentHydrationQueue((noteId) =>
		this.ensureNoteAttachments(noteId)
	);
	/** Called after cloud notes replace local state. Used to refresh reminder wakes. */
	onAfterSync: (() => void) | null = null;

	constructor() {
		this.notes = readNotesMirror();
		this.labels = readLabelsMirror();
		syncStore.onLocalDataChange = () => {
			this.dirty = true;
			this.scheduleSyncPush();
		};
		if (this.notes.length > 0) this.loaded = true;
		if (typeof window !== 'undefined') {
			window.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'hidden') this.mirrorToLS();
			});
			window.addEventListener('pagehide', () => this.mirrorToLS());
		}
	}

	// Derived collections -------------------------------------------------
	activeNotes = $derived(this.notes.filter((n) => !n.archived && !n.trashed));
	pinnedNotes = $derived(this.activeNotes.filter((n) => n.pinned));
	unpinnedNotes = $derived(this.activeNotes.filter((n) => !n.pinned));
	archivedNotes = $derived(this.notes.filter((n) => n.archived && !n.trashed));
	trashedNotes = $derived(this.notes.filter((n) => n.trashed));
	notesWithReminders = $derived(
		this.activeNotes
			.filter((n) => n.reminder != null)
			.sort((a, b) => (a.reminder ?? 0) - (b.reminder ?? 0))
	);

	// --- Lifecycle -------------------------------------------------------
	async init() {
		if (this.loaded) {
			await this.rehydrateFromIDB();
			return;
		}

		const mirrorNotes = this.notes.length ? this.notes : readNotesMirror();
		const mirrorLabels = this.labels.length ? this.labels : readLabelsMirror();
		let dbNotes: Note[] = [];
		let dbLabels: Label[] = [];
		let deviceReadFailed = false;
		try {
			[dbNotes, dbLabels] = await Promise.all([getAllNotesMetadata(), getAllLabels()]);
		} catch (err) {
			deviceReadFailed = true;
			this.recordPersistenceError('Could not read IndexedDB', err);
		}

		const notes = mergeNoteLists(mirrorNotes, dbNotes).sort((a, b) => b.updatedAt - a.updatedAt);
		const labels = mergeLabelLists(mirrorLabels, dbLabels).sort((a, b) =>
			a.name.localeCompare(b.name)
		);
		const seededFlag =
			typeof localStorage !== 'undefined' ? localStorage.getItem('gkc-seeded') : null;

		const tombstones = await hydrateTombstones().catch(() => ({
			notes: this.deletedNoteIds,
			labels: this.deletedLabelIds,
			boards: {}
		}));
		this.deletedNoteIds = tombstones.notes;
		this.deletedLabelIds = tombstones.labels;
		await kanbanStore.hydrateFromDevice(tombstones.boards);

		if (notes.length === 0 && labels.length === 0 && !seededFlag && !syncStore.isLoggedIn) {
			localStorage?.setItem('gkc-seeded', '1');
			this.notes = this.seedNotes();
			this.labels = [];
			this.mirrorToLS();
			try {
				await bulkPutNotes(this.notes);
			} catch (err) {
				this.recordPersistenceError('Could not save starter notes', err);
			}
		} else {
			this.notes = withoutTombstoned(notes, this.deletedNoteIds);
			this.labels = withoutTombstoned(labels, this.deletedLabelIds);
			this.mirrorToLS();
			if (!deviceReadFailed) {
				try {
					await this.recoverMirrorIntoIndexedDB(dbNotes, dbLabels);
				} catch (err) {
					this.recordPersistenceError('Could not restore IndexedDB from mirror', err);
				}
			}
			pruneOrphanImageBlobs().catch((err) =>
				this.recordPersistenceError('Could not reclaim unused photo storage', err)
			);
		}
		this.purgeOldTrash();
		this.loaded = true;
	}

	private async rehydrateFromIDB() {
		try {
			const [dbNotes, dbLabels] = await Promise.all([getAllNotesMetadata(), getAllLabels()]);
			this.notes = withoutTombstoned(mergeNoteLists(this.notes, dbNotes), this.deletedNoteIds).sort(
				(a, b) => b.updatedAt - a.updatedAt
			);
			this.labels = withoutTombstoned(
				mergeLabelLists(this.labels, dbLabels),
				this.deletedLabelIds
			).sort((a, b) => a.name.localeCompare(b.name));
			this.mirrorToLS();
		} catch (err) {
			this.recordPersistenceError('Could not rehydrate from IndexedDB', err);
		}
	}

	/** Fill a note's attachment placeholders without blocking the initial note render. */
	async ensureNoteAttachments(noteId: string): Promise<void> {
		const existing = this.notes.find((note) => note.id === noteId);
		if (!existing || !(existing.images ?? []).some((image) => !image.dataUrl)) return;
		const pending = this.attachmentLoads.get(noteId);
		if (pending) return pending;

		const source = cloneNote(existing);
		const load = hydrateNoteAttachments(source)
			.then((hydrated) => {
				const index = this.notes.findIndex((note) => note.id === noteId);
				if (index === -1) return;
				const current = this.notes[index];
				const images = mergeHydratedImages(current.images ?? [], hydrated.images ?? []);
				if (images.some((image, imageIndex) => image !== current.images?.[imageIndex])) {
					this.notes[index] = { ...current, images };
				}
			})
			.catch((err) =>
				this.recordPersistenceError(`Could not load attachments for note ${noteId}`, err)
			);
		this.attachmentLoads.set(noteId, load);
		return load.finally(() => {
			if (this.attachmentLoads.get(noteId) === load) this.attachmentLoads.delete(noteId);
		});
	}

	/** Explicit full hydration for sync, bounded to two complete notes at a time. */
	private hydrateAllAttachments(): Promise<void> {
		if (this.attachmentPass) return this.attachmentPass;
		const ids = this.notes
			.filter((note) => (note.images ?? []).some((image) => !image.dataUrl))
			.map((note) => note.id);
		if (ids.length === 0) return Promise.resolve();

		let next = 0;
		const worker = async () => {
			while (next < ids.length) {
				const noteId = ids[next++];
				await this.ensureNoteAttachments(noteId);
			}
		};
		this.attachmentPass = Promise.all(Array.from({ length: Math.min(2, ids.length) }, worker))
			.then(() => undefined)
			.finally(() => {
				this.attachmentPass = null;
			});
		return this.attachmentPass;
	}

	/** Only hydrate a few notes per sync so photo-heavy accounts transfer in fractions. */
	private async hydrateAttachmentsForSync(): Promise<void> {
		const dirtyKeys = new Set(await getSyncOutboxKeys().catch(() => []));
		const ids = this.notes
			.filter(
				(note) =>
					(dirtyKeys.has(`note:${note.id}`) ||
						(note.images ?? []).some((image) => dirtyKeys.has(`attachment:${image.id}`))) &&
					(note.images ?? []).some((image) => !image.dataUrl)
			)
			.map((note) => note.id);
		for (const noteId of ids) await this.ensureNoteAttachments(noteId);
	}

	/** Queue attachment bytes only when a note card enters the viewport. */
	requestVisibleNoteAttachments(noteId: string): void {
		const note = this.notes.find((item) => item.id === noteId);
		if (!note) return;
		// Prefer thumbs on cards. Only hydrate full blobs when a photo has no thumb at all
		// or a non-image file still lacks bytes.
		const needs = (note.images ?? []).some((image) => {
			const mime = (image.mime || '').toLowerCase();
			if (mime.startsWith('image/') && !mime.includes('dng') && mime !== 'image/tiff') {
				return !image.thumbUrl && !image.dataUrl;
			}
			return !image.dataUrl;
		});
		if (!needs) return;
		this.visibleAttachmentQueue.enqueue(noteId);
	}

	async flushNote(id: string, patch: Partial<Note> = {}): Promise<void> {
		const idx = this.notes.findIndex((x) => x.id === id);
		if (idx === -1) return;
		if (Object.keys(patch).length > 0) {
			const current = this.notes[idx];
			this.notes[idx] = {
				...current,
				...patch,
				updatedAt: Math.max(current.updatedAt, Date.now()),
				labels: patch.labels ? [...patch.labels] : current.labels,
				images: patch.images ? patch.images.map((image) => ({ ...image })) : current.images,
				linkPreviews: patch.linkPreviews
					? patch.linkPreviews.map((preview) => ({ ...preview }))
					: current.linkPreviews
			};
		}
		const note = this.notes[idx];
		this.mirrorToLS();
		try {
			await putNote(note, noteSyncKeys(note));
			this.lastPersistError = null;
			this.dirty = true;
			this.scheduleSyncPush();
		} catch (err) {
			this.recordPersistenceError(`Could not save note ${id}`, err);
			this.scheduleNoteRetry(id);
			throw err;
		}
	}

	async discardIfEmpty(id: string): Promise<void> {
		const n = this.notes.find((x) => x.id === id);
		if (!n || !noteIsBlank(n)) return;
		await this.deleteNoteForever(id);
	}

	/** Remove notes that have been in trash > 7 days. */
	purgeOldTrash() {
		const ids = this.notes
			.filter((n) => n.trashed && daysSinceTrashed(n.trashedAt) >= TRASH_PURGE_DAYS)
			.map((n) => n.id);
		if (ids.length === 0) return;
		void this.persistDeletedNotes(ids).catch((err) =>
			this.recordPersistenceError('Could not purge expired trash', err)
		);
	}

	// --- CRUD ------------------------------------------------------------
	createNote(partial: Partial<Note> = {}): Note {
		const now = Date.now();
		const note: Note = {
			id: uid(),
			title: partial.title ?? '',
			body: partial.body ?? '',
			color: partial.color ?? 'default',
			pinned: partial.pinned ?? false,
			archived: false,
			trashed: false,
			trashedAt: null,
			createdAt: now,
			updatedAt: now,
			reminder: partial.reminder ?? null,
			labels: [...(partial.labels ?? [])],
			images: (partial.images ?? []).map((image) => ({ ...image })),
			fieldTimes: {
				title: now,
				body: now,
				color: now,
				pinned: now,
				archived: now,
				trashed: now,
				reminder: now,
				labels: now,
				images: now,
				linkPreviews: now
			},
			...(partial.linkPreviews?.length
				? { linkPreviews: partial.linkPreviews.map((preview) => ({ ...preview })) }
				: {})
		};
		this.notes = [note, ...this.notes];
		this.persist(note.id);
		return note;
	}

	updateNote(id: string, patch: Partial<Note>): void {
		const idx = this.notes.findIndex((n) => n.id === id);
		if (idx === -1) return;
		const current = this.notes[idx];
		const fields: NoteField[] = [];
		if ('title' in patch) fields.push('title');
		if ('body' in patch) fields.push('body');
		if ('color' in patch) fields.push('color');
		if ('pinned' in patch) fields.push('pinned');
		if ('archived' in patch) fields.push('archived');
		if ('trashed' in patch) fields.push('trashed');
		if ('reminder' in patch) fields.push('reminder');
		if ('labels' in patch) fields.push('labels');
		if ('images' in patch) fields.push('images');
		if ('linkPreviews' in patch) fields.push('linkPreviews');
		const next: Note = touchNoteFields(
			{
				...current,
				...patch,
				labels: patch.labels ? [...patch.labels] : current.labels,
				images: patch.images ? patch.images.map((image) => ({ ...image })) : current.images,
				linkPreviews: patch.linkPreviews
					? patch.linkPreviews.map((preview) => ({ ...preview }))
					: current.linkPreviews
			},
			fields
		);
		this.notes[idx] = next;
		this.persist(id);
	}

	togglePin(id: string): void {
		const n = this.notes.find((x) => x.id === id);
		if (!n) return;
		this.updateNote(id, { pinned: !n.pinned });
	}

	toggleArchive(id: string): void {
		const n = this.notes.find((x) => x.id === id);
		if (!n) return;
		this.updateNote(id, { archived: !n.archived, pinned: false });
	}

	setColor(id: string, color: NoteColor): void {
		this.updateNote(id, { color });
	}

	setReminder(id: string, reminder: number | null): void {
		this.updateNote(id, { reminder });
	}

	/** Toggle `[ ]` / `[x]` line in unified body text. */
	toggleBodyChecklistLine(noteId: string, lineIndex: number): void {
		const n = this.notes.find((x) => x.id === noteId);
		if (!n) return;
		const body = toggleLineAt(n.body ?? '', lineIndex);
		this.updateNote(noteId, { body });
	}

	toggleLabel(noteId: string, labelId: string): void {
		const n = this.notes.find((x) => x.id === noteId);
		if (!n) return;
		const labels = n.labels.includes(labelId)
			? n.labels.filter((l) => l !== labelId)
			: [...n.labels, labelId];
		this.updateNote(noteId, { labels });
	}

	// Trash ----------------------------------------------------------------
	trashNote(id: string): void {
		this.updateNote(id, { trashed: true, trashedAt: Date.now(), pinned: false });
	}

	restoreNote(id: string): void {
		this.updateNote(id, { trashed: false, trashedAt: null });
	}

	async deleteNoteForever(id: string): Promise<void> {
		const deletedAt = Date.now();
		const next = { ...this.deletedNoteIds, [id]: deletedAt };
		await writeTombstones(next);
		this.deletedNoteIds = next;
		this.notes = this.notes.filter((n) => n.id !== id);
		this.mirrorToLS();
		await deleteNote(id).catch((err) =>
			this.recordPersistenceError(`Could not delete note ${id}`, err)
		);
		await syncStore.queueOutbox([`note-tombstone:${id}`]);
		this.dirty = true;
		this.scheduleSyncPush();
	}

	emptyTrash(): void {
		const ids = this.trashedNotes.map((n) => n.id);
		if (ids.length === 0) return;
		void this.persistDeletedNotes(ids).catch((err) =>
			this.recordPersistenceError('Could not empty trash', err)
		);
	}

	// Labels ---------------------------------------------------------------
	createLabel(name: string): Label | null {
		const trimmed = name.trim();
		if (!trimmed) return null;
		if (this.labels.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) return null;
		const now = Date.now();
		const label: Label = { id: uid(), name: trimmed, createdAt: now, updatedAt: now };
		this.labels = [...this.labels, label].sort((a, b) => a.name.localeCompare(b.name));
		this.mirrorToLS();
		putLabel(label).catch((err) => this.recordPersistenceError('Could not save label', err));
		this.markLabelsDirty([`label:${label.id}`]);
		return label;
	}

	renameLabel(id: string, name: string): void {
		const trimmed = name.trim();
		if (!trimmed) return;
		const idx = this.labels.findIndex((l) => l.id === id);
		if (idx === -1) return;
		const renamed = { ...this.labels[idx], name: trimmed, updatedAt: Date.now() };
		this.labels[idx] = renamed;
		this.labels.sort((a, b) => a.name.localeCompare(b.name));
		this.mirrorToLS();
		putLabel(renamed).catch((err) => this.recordPersistenceError('Could not rename label', err));
		this.markLabelsDirty([`label:${renamed.id}`]);
	}

	removeLabel(id: string, options: { deleteNotes?: boolean } = {}): void {
		if (!this.labels.some((label) => label.id === id)) return;
		const deletedAt = Date.now();
		const affected = this.notes.filter((note) => note.labels.includes(id));

		if (options.deleteNotes) {
			// Trash notes that carry this label (recoverable from Trash).
			this.notes = this.notes.map((note) => {
				if (!note.labels.includes(id)) return note;
				if (note.trashed) {
					return touchNoteFields(
						{ ...note, labels: note.labels.filter((labelId) => labelId !== id) },
						['labels'],
						deletedAt
					);
				}
				return touchNoteFields(
					{
						...note,
						labels: note.labels.filter((labelId) => labelId !== id),
						trashed: true,
						trashedAt: deletedAt,
						pinned: false
					},
					['labels', 'trashed', 'pinned'],
					deletedAt
				);
			});
			this.labels = this.labels.filter((label) => label.id !== id);
			this.mirrorToLS();
			deleteLabel(id).catch((err) => this.recordPersistenceError('Could not delete label', err));
			for (const note of affected) this.persist(note.id);
			this.markLabelsDeleted([id], deletedAt);
			return;
		}

		this.labels = this.labels.filter((label) => label.id !== id);
		const affectedNoteIds: string[] = [];
		this.notes = this.notes.map((note) => {
			if (!note.labels.includes(id)) return note;
			affectedNoteIds.push(note.id);
			return touchNoteFields(
				{ ...note, labels: note.labels.filter((labelId) => labelId !== id) },
				['labels'],
				deletedAt
			);
		});
		this.mirrorToLS();
		deleteLabel(id).catch((err) => this.recordPersistenceError('Could not delete label', err));
		for (const noteId of affectedNoteIds) this.persist(noteId);
		this.markLabelsDeleted([id], deletedAt);
	}

	notesForLabel(id: string): Note[] {
		return this.activeNotes.filter((n) => n.labels.includes(id));
	}

	// Search ---------------------------------------------------------------
	search(query: string, pool?: Note[]): Note[] {
		const q = query.trim().toLowerCase();
		if (!q) return pool ?? this.activeNotes;
		const base = pool ?? this.activeNotes;
		return base.filter((n) => {
			const inTitle = n.title.toLowerCase().includes(q);
			const inBody = (n.body ?? '').toLowerCase().includes(q);
			const inLabels = n.labels.some((lid) =>
				this.labels
					.find((l) => l.id === lid)
					?.name.toLowerCase()
					.includes(q)
			);
			return inTitle || inBody || inLabels;
		});
	}

	// Backup ---------------------------------------------------------------
	/**
	 * Full app/DB backup: notes (with full-resolution attachments), labels, boards,
	 * tombstones, and UI prefs. Never carries sync identity.
	 */
	async exportBackup(): Promise<ScrapsCacheBackup> {
		const fullNotes: Note[] = [];
		for (const note of this.notes) {
			const needsFull = (note.images ?? []).some((image) => !image.dataUrl);
			fullNotes.push(needsFull ? await hydrateNoteAttachments(cloneNote(note)) : cloneNote(note));
		}
		return {
			version: 4,
			exportedAt: Date.now(),
			notes: fullNotes,
			labels: this.labels.map((label) => ({ ...label })),
			boards: kanbanStore.boardsForSync(),
			activeBoardId: kanbanStore.activeBoardId,
			tombstones: { ...this.deletedNoteIds },
			labelTombstones: { ...this.deletedLabelIds },
			boardTombstones: kanbanStore.boardTombstonesForSync(),
			ui: {
				sidebarOpen: uiStore.sidebarOpen,
				dark: uiStore.dark,
				layout: uiStore.layout,
				view: uiStore.view
			},
			// Kept empty for v1-v3 import compatibility; new backups never retain remote metadata.
			linkPreviews: []
		};
	}

	private async compactPersistedNoteImages(note: Note): Promise<void> {
		const images: NoteImage[] = [];
		for (const image of note.images ?? []) {
			let next = image;
			if (image.dataUrl && !image.thumbUrl && (image.mime || '').startsWith('image/')) {
				const thumbUrl = await makeImageThumbDataUrl(image.dataUrl);
				if (thumbUrl) next = { ...image, thumbUrl };
			}
			images.push(stripFullImageBytes(next));
		}
		note.images = images;
	}

	async importBackup(data: unknown): Promise<{ success: boolean; error?: string }> {
		if (this.backupImportProgress)
			return { success: false, error: 'A backup import is already running.' };
		const backup = normalizeBackup(data);
		if (!backup)
			return { success: false, error: 'That file is not a valid Scraps Cache full backup.' };
		try {
			if (navigator.storage?.estimate) {
				const estimate = await navigator.storage.estimate();
				if (!replacementFitsStorage(backup.notes, estimate)) {
					return {
						success: false,
						error: 'Storage full on this device — free space or remove old notes/attachments.'
					};
				}
			}
			this.backupImportProgress = { phase: 'writing', completed: 0, total: backup.notes.length };
			await replaceAllDeviceData(backup.notes, backup.labels, async (note) => {
				await this.compactPersistedNoteImages(note);
				if (this.backupImportProgress) this.backupImportProgress.completed += 1;
			});

			this.backupImportProgress = {
				phase: 'finishing',
				completed: backup.notes.length,
				total: backup.notes.length
			};
			this.notes = backup.notes.sort((a, b) => b.updatedAt - a.updatedAt);
			this.labels = [...backup.labels].sort((a, b) => a.name.localeCompare(b.name));
			this.deletedNoteIds = { ...backup.tombstones };
			this.deletedLabelIds = { ...backup.labelTombstones };
			await writeTombstones(this.deletedNoteIds);
			await writeLabelTombstones(this.deletedLabelIds);
			kanbanStore.replaceWithCloud(backup.boards, backup.boardTombstones);
			if (
				backup.activeBoardId &&
				kanbanStore.boards.some((board) => board.id === backup.activeBoardId)
			) {
				kanbanStore.selectBoard(backup.activeBoardId);
			}
			uiStore.restoreState(backup.ui);
			this.mirrorToLS();
			const outbox = [
				...this.notes.flatMap((note) => [
					`note:${note.id}`,
					...(note.images ?? []).map((image) => `attachment:${image.id}`)
				]),
				...this.labels.map((label) => `label:${label.id}`),
				...kanbanStore.boards.map((board) => `board:${board.id}`),
				...Object.keys(this.deletedNoteIds).map((id) => `note-tombstone:${id}`),
				...Object.keys(this.deletedLabelIds).map((id) => `label-tombstone:${id}`),
				...Object.keys(kanbanStore.boardTombstones).map((id) => `board-tombstone:${id}`)
			];
			if (syncStore.account) {
				await syncStore.clearAccountControlPlane(syncStore.account.accountId);
			}
			await syncStore.queueOutbox(outbox);
			this.dirty = true;
			this.scheduleSyncPush();
			return { success: true };
		} catch (err) {
			this.recordPersistenceError('Could not import full backup', err);
			return { success: false, error: this.lastPersistError ?? 'Could not import full backup.' };
		} finally {
			this.backupImportProgress = null;
		}
	}

	// Reload all three layers. Mirror is only a fast-boot cache; IDB always participates so
	// image blobs are rehydrated even when a mirror exists.
	async hardResync() {
		const mirrorNotes = readNotesMirror();
		const mirrorLabels = readLabelsMirror();
		try {
			const [dbNotes, dbLabels] = await Promise.all([getAllNotesMetadata(), getAllLabels()]);
			this.notes = mergeNoteLists(mirrorNotes, dbNotes).sort((a, b) => b.updatedAt - a.updatedAt);
			this.labels = mergeLabelLists(mirrorLabels, dbLabels).sort((a, b) =>
				a.name.localeCompare(b.name)
			);
			this.mirrorToLS();
		} catch (err) {
			this.recordPersistenceError('Could not refresh from IndexedDB', err);
		}
		this.purgeOldTrash();
	}

	// Persistence helpers --------------------------------------------------

	private async persistDeletedNotes(ids: string[]): Promise<void> {
		if (ids.length === 0) return;
		const deletedAt = Date.now();
		const next = { ...this.deletedNoteIds };
		for (const id of ids) next[id] = deletedAt;
		await writeTombstones(next);
		this.deletedNoteIds = next;
		this.notes = this.notes.filter((n) => !ids.includes(n.id));
		this.mirrorToLS();
		this.dirty = true;
		this.scheduleSyncPush();
		await syncStore.queueOutbox(ids.map((id) => `note-tombstone:${id}`));
		await Promise.all(ids.map((id) => deleteNote(id)));
	}

	private markLabelsDeleted(ids: string[], deletedAt = Date.now()): void {
		if (ids.length === 0) return;
		for (const id of ids) this.deletedLabelIds[id] = deletedAt;
		void writeLabelTombstones(this.deletedLabelIds).then(() =>
			this.markLabelsDirty(ids.map((id) => `label-tombstone:${id}`))
		);
	}

	private markLabelsDirty(keys: Iterable<string> = []): void {
		syncStore.requestAutoSync(keys);
		this.dirty = true;
		this.scheduleSyncPush();
	}

	private mirrorToLS() {
		writeNotesMirror(this.notes);
		writeLabelsMirror(this.labels);
	}

	private recordPersistenceError(context: string, err: unknown): void {
		const detail = formatStorageError(err);
		this.lastPersistError = `${context}: ${detail}`;
		console.error(`[notes] ${context}`, err);
	}

	private syncPushTimer: ReturnType<typeof setTimeout> | null = null;
	private noteRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private noteRetryAttempts = new Map<string, number>();
	private dirty = false;
	private syncFlight: Promise<boolean> | null = null;
	private syncFollowupRequested = false;

	private scheduleNoteRetry(id: string): void {
		if (this.noteRetryTimers.has(id)) return;
		const attempt = this.noteRetryAttempts.get(id) ?? 0;
		const delay = Math.min(30_000, 1_000 * 2 ** attempt);
		const timer = setTimeout(() => {
			this.noteRetryTimers.delete(id);
			const note = this.notes.find((item) => item.id === id);
			if (!note) return;
			putNote(note, noteSyncKeys(note))
				.then(() => {
					this.noteRetryAttempts.delete(id);
					this.lastPersistError = null;
					this.dirty = true;
					this.scheduleSyncPush();
				})
				.catch((err) => {
					this.noteRetryAttempts.set(id, attempt + 1);
					this.recordPersistenceError(`Could not retry note ${id}`, err);
					this.scheduleNoteRetry(id);
				});
		}, delay);
		this.noteRetryTimers.set(id, timer);
	}

	/** Replay localStorage notes/labels that never landed in IndexedDB after a crash. */
	private async recoverMirrorIntoIndexedDB(dbNotes: Note[], dbLabels: Label[]): Promise<void> {
		const dbById = new Map(dbNotes.map((item) => [item.id, item]));
		for (const item of this.notes) {
			if (noteNeedsDurableWrite(dbById.get(item.id), item)) await putNote(item, noteSyncKeys(item));
		}
		const dbLabelById = new Map(dbLabels.map((item) => [item.id, item]));
		const labelKeys: string[] = [];
		for (const label of this.labels) {
			const current = dbLabelById.get(label.id);
			if (current && current.name === label.name && current.updatedAt === label.updatedAt) continue;
			await putLabel(label);
			labelKeys.push(`label:${label.id}`);
		}
		if (labelKeys.length) await syncStore.queueOutbox(labelKeys);
	}

	private persist(id: string) {
		const note = this.notes.find((x) => x.id === id);
		if (!note) return;
		// Preserve a crash-safe, blob-free copy synchronously before async IDB work.
		this.mirrorToLS();
		putNote(note, noteSyncKeys(note))
			.then(async () => {
				this.lastPersistError = null;
				// Keep only small thumbs in memory after a durable write of full blobs.
				const idx = this.notes.findIndex((item) => item.id === id);
				if (idx < 0) return;
				const current = this.notes[idx];
				const images = await Promise.all(
					(current.images ?? []).map(async (image) => {
						let next = image;
						if (image.dataUrl && !image.thumbUrl && (image.mime || '').startsWith('image/')) {
							const thumbUrl = await makeImageThumbDataUrl(image.dataUrl);
							if (thumbUrl) next = { ...image, thumbUrl };
						}
						return stripFullImageBytes(next);
					})
				);
				if (images.some((image, i) => image !== current.images?.[i])) {
					this.notes[idx] = { ...current, images };
					this.mirrorToLS();
				}
			})
			.catch((err) => {
				this.recordPersistenceError(`Could not save note ${id}`, err);
				this.scheduleNoteRetry(id);
			});
		this.dirty = true;
		this.scheduleSyncPush();
	}

	private scheduleSyncPush() {
		if (this.syncFlight) this.syncFollowupRequested = true;
		if (this.syncPushTimer) clearTimeout(this.syncPushTimer);
		this.syncPushTimer = setTimeout(() => {
			if (!this.dirty) return;
			void this.flushSync();
		}, 5000);
	}

	flushSync(indicate = false): Promise<boolean> {
		if (this.syncPushTimer) {
			clearTimeout(this.syncPushTimer);
			this.syncPushTimer = null;
		}
		return this.queueSync(indicate).then(async (synced) => {
			const leftover = synced ? await getSyncOutboxKeys().catch(() => []) : [];
			if (synced && leftover.length === 0) {
				this.dirty = false;
			} else if (this.dirty || leftover.length > 0) {
				this.dirty = true;
				this.scheduleSyncPush();
			}
			return synced;
		});
	}

	/** Flush durable local changes when leaving a note, without a no-op cloud request. */
	async syncPendingChanges(): Promise<boolean> {
		if (!syncStore.isLoggedIn) return false;
		await syncStore.waitForOutboxWrites();
		const pending = await getSyncOutboxKeys().catch(() => []);
		if (pending.length === 0) return false;
		return this.flushSync(true);
	}

	private async notesForMemory(notes: Note[]): Promise<Note[]> {
		return Promise.all(
			notes.map(async (note) => ({
				...note,
				images: await Promise.all(
					(note.images ?? []).map(async (image) => {
						let next = image;
						if (image.dataUrl && !image.thumbUrl && (image.mime || '').startsWith('image/')) {
							const thumbUrl = await makeImageThumbDataUrl(image.dataUrl);
							if (thumbUrl) next = { ...image, thumbUrl };
						}
						return stripFullImageBytes(next);
					})
				)
			}))
		);
	}

	private async applyPulledSnapshot(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
		const tombstones = { ...this.deletedNoteIds };
		for (const [id, deletedAt] of Object.entries(snapshot.tombstones)) {
			if (deletedAt > (tombstones[id] || 0)) tombstones[id] = deletedAt;
		}
		const labelTombstones = { ...this.deletedLabelIds };
		for (const [id, deletedAt] of Object.entries(snapshot.labelTombstones)) {
			if (deletedAt > (labelTombstones[id] || 0)) labelTombstones[id] = deletedAt;
		}

		let durableNotes = withoutTombstoned(
			mergeNoteLists(this.notes, snapshot.notes),
			tombstones
		).sort((a, b) => b.updatedAt - a.updatedAt);
		let mergedLabels = withoutTombstoned(
			mergeLabelLists(this.labels, snapshot.labels),
			labelTombstones
		).sort((a, b) => a.name.localeCompare(b.name));
		const currentById = new Map(this.notes.map((note) => [note.id, note]));
		const notesToPersist = durableNotes.filter((note) =>
			noteNeedsDurableWrite(currentById.get(note.id), note)
		);
		const labelsChanged = stableStringify(this.labels) !== stableStringify(mergedLabels);
		const tombstonedNoteIds = this.notes
			.filter((note) => tombstones[note.id])
			.map((note) => note.id);
		const tombstonedLabelIds = this.labels
			.filter((label) => labelTombstones[label.id])
			.map((label) => label.id);

		kanbanStore.applySync(snapshot.boards, snapshot.boardTombstones);
		await writeTombstones(tombstones);
		await writeLabelTombstones(labelTombstones);
		for (const note of notesToPersist) await putNote(note);
		for (const id of tombstonedNoteIds) await deleteNote(id);
		for (const id of tombstonedLabelIds) await deleteLabel(id);
		if (labelsChanged) await bulkPutLabels(mergedLabels);
		await kanbanStore.persistSyncState();

		// Preserve edits made while the device writes were in flight.
		durableNotes = withoutTombstoned(mergeNoteLists(this.notes, durableNotes), tombstones).sort(
			(a, b) => b.updatedAt - a.updatedAt
		);
		mergedLabels = withoutTombstoned(
			mergeLabelLists(this.labels, mergedLabels),
			labelTombstones
		).sort((a, b) => a.name.localeCompare(b.name));
		this.notes = await this.notesForMemory(durableNotes);
		this.labels = mergedLabels;
		this.deletedNoteIds = tombstones;
		this.deletedLabelIds = labelTombstones;
		this.mirrorToLS();
		this.lastPersistError = null;

		return {
			notes: durableNotes,
			labels: mergedLabels,
			boards: kanbanStore.boardsForSync(),
			tombstones: { ...tombstones },
			labelTombstones: { ...labelTombstones },
			boardTombstones: kanbanStore.boardTombstonesForSync()
		};
	}

	private async applyCloudReplacement(snapshot: SyncSnapshot): Promise<SyncSnapshot> {
		const notes = withoutTombstoned(snapshot.notes, snapshot.tombstones).sort(
			(a, b) => b.updatedAt - a.updatedAt
		);
		const labels = withoutTombstoned(snapshot.labels, snapshot.labelTombstones).sort((a, b) =>
			a.name.localeCompare(b.name)
		);
		if (notes.length === 0 && (syncStore.usage?.envelopeCount ?? 0) > 0) {
			throw new Error('Could not download synced notes');
		}
		if (navigator.storage?.estimate) {
			const estimate = await navigator.storage.estimate();
			if (!replacementFitsStorage(notes, estimate)) {
				throw new Error(
					'Storage full on this device — free space or remove old notes/attachments.'
				);
			}
		}
		await replaceAllDeviceData(notes, labels, (note) => this.compactPersistedNoteImages(note));
		this.notes = notes;
		this.labels = labels;
		this.deletedNoteIds = { ...snapshot.tombstones };
		this.deletedLabelIds = { ...snapshot.labelTombstones };
		kanbanStore.replaceWithCloud(snapshot.boards, snapshot.boardTombstones);
		await writeTombstones(this.deletedNoteIds);
		await writeLabelTombstones(this.deletedLabelIds);
		await kanbanStore.persistSyncState();
		this.mirrorToLS();
		return {
			notes,
			labels,
			boards: kanbanStore.boardsForSync(),
			tombstones: { ...this.deletedNoteIds },
			labelTombstones: { ...this.deletedLabelIds },
			boardTombstones: kanbanStore.boardTombstonesForSync()
		};
	}

	/** Pairing merge: keep every local note and every account note. Same ids get a new local id. */
	async mergeWithCloudManual(): Promise<boolean> {
		if (!syncStore.isLoggedIn || !syncStore.account) return false;
		const original = this.notes.map(cloneNote);
		try {
			await this.hydrateAllAttachments();
			const leftover = await getSyncOutboxKeys().catch(() => []);
			if (leftover.length) await clearSyncOutbox(leftover);
			await syncStore.clearAccountControlPlane(syncStore.account.accountId);
			const pulledSnapshots: SyncSnapshot[] = [];
			const pulled = await syncStore.sync([], [], {}, {}, [], {}, true, true, async (snapshot) => {
				pulledSnapshots.push({
					notes: snapshot.notes.map(cloneNote),
					labels: snapshot.labels.map((label) => ({ ...label })),
					boards: snapshot.boards.map((board) => ({
						...board,
						columns: board.columns.map((column) => ({ ...column })),
						backlogFilter: {
							...board.backlogFilter,
							labelIds: [...board.backlogFilter.labelIds]
						}
					})),
					tombstones: { ...snapshot.tombstones },
					labelTombstones: { ...snapshot.labelTombstones },
					boardTombstones: { ...snapshot.boardTombstones }
				});
				return snapshot;
			});
			const server = pulledSnapshots.at(-1);
			if (!pulled.success || !server) {
				this.recordPersistenceError(
					pulled.error || 'Could not download synced notes',
					pulled.error
				);
				return false;
			}
			const remapped = retargetLocalNotes(
				this.notes.map(cloneNote),
				server.notes,
				server.tombstones,
				uid
			);
			for (let index = 0; index < original.length; index++) {
				const before = original[index];
				const after = remapped[index];
				const imagesChanged = (after.images ?? []).some(
					(image, imageIndex) => image.id !== (before.images ?? [])[imageIndex]?.id
				);
				if (before.id !== after.id || imagesChanged) {
					await putNote(after, noteSyncKeys(after));
				}
			}
			this.notes = remapped;
			try {
				await this.applyPulledSnapshot(server);
			} catch (err) {
				this.notes = original;
				throw err;
			}
			const kept = new Set(this.notes.map((note) => note.id));
			for (const note of original) {
				if (!kept.has(note.id)) await deleteNote(note.id);
			}
			await syncStore.clearAccountControlPlane(syncStore.account.accountId);
			return this.syncWithCloudManual();
		} catch (err) {
			this.recordPersistenceError('Could not merge local notes with synced notes', err);
			return false;
		}
	}

	// Replace this device's local data with the already-linked account without uploading any
	// local records or tombstones first. The cloud response is obtained before local storage is cleared.
	async replaceWithCloudManual(): Promise<boolean> {
		if (!syncStore.isLoggedIn || !syncStore.account) return false;
		try {
			const leftover = await getSyncOutboxKeys().catch(() => []);
			if (leftover.length) await clearSyncOutbox(leftover);
			await syncStore.clearAccountControlPlane(syncStore.account.accountId);
			const result = await syncStore.sync([], [], {}, {}, [], {}, true, true, (snapshot) =>
				this.applyCloudReplacement(snapshot)
			);
			if (!result.success || !result.notes) {
				this.recordPersistenceError(result.error || 'Cloud sync returned no notes', result.error);
				return false;
			}
			this.dirty = false;
			this.lastPersistError = null;
			this.onAfterSync?.();
			return true;
		} catch (err) {
			this.recordPersistenceError('Could not replace this device with cloud notes', err);
			return false;
		}
	}

	// Manual sync — caller shows UI feedback (spinning cloud icon).
	async syncWithCloudManual(): Promise<boolean> {
		return this.queueSync(true);
	}

	// Auto sync — silent, no UI feedback. Opportunistic pulls (boot, editor
	// open) are throttled; pending local edits always sync via flushSync.
	async syncWithCloud(): Promise<boolean> {
		if (Date.now() - this.lastAutoSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) return true;
		const synced = await this.queueSync(false);
		if (synced) this.lastAutoSyncAt = Date.now();
		return synced;
	}

	/** One sync at a time; edits during a flight collapse into exactly one follow-up pass. */
	private queueSync(indicate: boolean): Promise<boolean> {
		if (this.syncFlight) {
			this.syncFollowupRequested = true;
			// A silent flight already in progress still owes the cloud icon a pulse.
			if (indicate) {
				syncStore.onSyncStart?.();
				return this.syncFlight.finally(() => {
					syncStore.onSyncEnd?.();
				});
			}
			return this.syncFlight;
		}
		this.syncFlight = (async () => {
			let success = false;
			let showProgress = indicate;
			do {
				this.syncFollowupRequested = false;
				success = await this.doSync(showProgress);
				showProgress = false;
			} while (this.syncFollowupRequested);
			return success;
		})().finally(() => {
			this.syncFlight = null;
		});
		return this.syncFlight;
	}

	private async withSyncLock<T>(run: () => Promise<T>): Promise<T> {
		const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
		if (!locks?.request) return run();
		return locks.request('scraps-cache-sync', run);
	}

	// Core sync. Local IDB remains authoritative; photo bytes move in small fractions.
	private async doSync(indicate = false): Promise<boolean> {
		return this.withSyncLock(() => this.doSyncLocked(indicate));
	}

	private async doSyncLocked(indicate = false): Promise<boolean> {
		if (!syncStore.isLoggedIn) return false;
		// A newly reset relay needs one current-state bootstrap from this source device.
		// Bytes are returned to thumb-only memory immediately after reconciliation below.
		if (await syncStore.needsCurrentStateBootstrap()) await this.hydrateAllAttachments();
		// Only pull a few full attachments into memory per normal cycle for upload readiness.
		await this.hydrateAttachmentsForSync();
		const localNotes = this.notes.map(cloneNote);
		const localLabels = [...this.labels];
		try {
			const result = await syncStore.sync(
				localNotes,
				localLabels,
				this.deletedNoteIds,
				this.deletedLabelIds,
				kanbanStore.boardsForSync(),
				kanbanStore.boardTombstonesForSync(),
				indicate,
				false,
				(snapshot) => this.applyPulledSnapshot(snapshot)
			);
			if (!result.success || !result.notes) {
				this.recordPersistenceError(result.error || 'Cloud sync returned no notes', result.error);
				return false;
			}
			if (syncStore.consumeCurrentStateBootstrapRequest()) {
				await this.hydrateAllAttachments();
				return this.doSyncLocked(indicate);
			}
			this.lastPersistError = null;
			this.onAfterSync?.();
			return true;
		} catch (err) {
			this.recordPersistenceError('Cloud sync reconciliation failed', err);
			return false;
		}
	}

	// Seed -----------------------------------------------------------------
	private seedNotes(): Note[] {
		const now = Date.now();
		return [
			{
				id: uid(),
				title: 'Welcome to Scraps Cache 👋',
				body: 'Small note fragments, offline-first. Notes live on this device and sync when you sign in. Try pins, archive, colours, checklists, and reminders.',
				color: 'yellow',
				pinned: true,
				archived: false,
				trashed: false,
				trashedAt: null,
				createdAt: now,
				updatedAt: now,
				reminder: null,
				labels: []
			},
			{
				id: uid(),
				title: 'Groceries',
				body: '[x] Oat milk\n[ ] Sourdough bread\n[ ] Avocados\n[ ] Dark chocolate',
				color: 'green',
				pinned: false,
				archived: false,
				trashed: false,
				trashedAt: null,
				createdAt: now - 1000,
				updatedAt: now - 1000,
				reminder: null,
				labels: []
			},
			{
				id: uid(),
				title: 'Reading list',
				body: 'Antifragile — Taleb\nThe Beginning of Infinity — Deutsch',
				color: 'blue',
				pinned: false,
				archived: false,
				trashed: false,
				trashedAt: null,
				createdAt: now - 2000,
				updatedAt: now - 2000,
				reminder: null,
				labels: []
			}
		];
	}
}

export const notesStore = new NotesStore();
