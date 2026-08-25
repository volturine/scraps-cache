// Durable delete manifests in IndexedDB. Permanent delete wins until the
// tombstone is cleared. localStorage is only a first-paint cache during hydrate.
import { getSyncState, setSyncState, writeSyncStateWithOutbox } from '$lib/db/idb';

const NOTE_LS = 'scrapscache-note-tombstones';
const LABEL_LS = 'scrapscache-label-tombstones';
const NOTE_IDB = 'scrapscache-idb-note-tombstones';
const LABEL_IDB = 'scrapscache-idb-label-tombstones';
const BOARD_IDB = 'scrapscache-idb-board-tombstones';
const MIGRATED_IDB = 'scrapscache-idb-tombstones-migrated';
const BOARDS_IDB = 'scrapscache-idb-kanban-boards';

export type Tombstones = Record<string, number>;

function sanitize(value: unknown): Tombstones {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([id, at]) =>
			typeof id === 'string' && Number(at) > 0 ? [[id, Number(at)]] : []
		)
	);
}

function readLegacy(key: string): Tombstones {
	if (typeof localStorage === 'undefined') return {};
	try {
		return sanitize(JSON.parse(localStorage.getItem(key) || '{}'));
	} catch (err) {
		console.error('[sync] could not read delete tombstones:', err);
		return {};
	}
}

let noteCache: Tombstones | null = null;
let labelCache: Tombstones | null = null;
let boardCache: Tombstones | null = null;

export function resetTombstoneCaches(): void {
	noteCache = null;
	labelCache = null;
	boardCache = null;
}

export function readTombstones(): Tombstones {
	return { ...(noteCache ?? readLegacy(NOTE_LS)) };
}

export function readLabelTombstones(): Tombstones {
	return { ...(labelCache ?? readLegacy(LABEL_LS)) };
}

export function readBoardTombstones(): Tombstones {
	return { ...(boardCache ?? {}) };
}

export async function writeTombstones(tombstones: Tombstones): Promise<void> {
	noteCache = sanitize(tombstones);
	await setSyncState(NOTE_IDB, noteCache);
	if (typeof localStorage !== 'undefined') localStorage.removeItem(NOTE_LS);
}

export async function writeLabelTombstones(
	tombstones: Tombstones,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	labelCache = sanitize(tombstones);
	await writeSyncStateWithOutbox([[LABEL_IDB, labelCache]], syncOutboxKeys);
	if (typeof localStorage !== 'undefined') localStorage.removeItem(LABEL_LS);
}

export async function hydrateTombstones(): Promise<{
	notes: Tombstones;
	labels: Tombstones;
	boards: Tombstones;
}> {
	const [migrated, idbNotes, idbLabels, idbBoards] = await Promise.all([
		getSyncState<unknown>(MIGRATED_IDB),
		getSyncState<unknown>(NOTE_IDB),
		getSyncState<unknown>(LABEL_IDB),
		getSyncState<unknown>(BOARD_IDB)
	]);
	// An empty IDB map is legitimate (all tombstones cleared); only fall back to
	// localStorage when this device never migrated in the first place.
	noteCache = sanitize(idbNotes);
	if (migrated !== true && !Object.keys(noteCache).length) noteCache = readLegacy(NOTE_LS);
	labelCache = sanitize(idbLabels);
	if (migrated !== true && !Object.keys(labelCache).length) labelCache = readLegacy(LABEL_LS);
	boardCache = sanitize(idbBoards);
	await Promise.all([
		setSyncState(NOTE_IDB, noteCache),
		setSyncState(LABEL_IDB, labelCache),
		setSyncState(BOARD_IDB, boardCache),
		setSyncState(MIGRATED_IDB, true)
	]);
	if (typeof localStorage !== 'undefined') {
		localStorage.removeItem(NOTE_LS);
		localStorage.removeItem(LABEL_LS);
	}
	return { notes: { ...noteCache }, labels: { ...labelCache }, boards: { ...boardCache } };
}

export async function loadBoardsFromDevice<T>(fallback: T): Promise<T> {
	const stored = await getSyncState<T>(BOARDS_IDB);
	return stored ?? fallback;
}

export async function saveBoardsToDevice<T>(boards: T): Promise<void> {
	// `$state` board proxies throw DataCloneError in IndexedDB; JSON is already how
	// localStorage snapshots them.
	await setSyncState(BOARDS_IDB, JSON.parse(JSON.stringify(boards ?? [])));
}

/** Persist boards, tombstones, and optional upload markers in one transaction. */
export async function writeKanbanState(
	boards: unknown,
	boardTombstones: Tombstones,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	boardCache = sanitize(boardTombstones);
	await writeSyncStateWithOutbox(
		[
			[BOARDS_IDB, JSON.parse(JSON.stringify(boards ?? []))],
			[BOARD_IDB, boardCache]
		],
		syncOutboxKeys
	);
}
