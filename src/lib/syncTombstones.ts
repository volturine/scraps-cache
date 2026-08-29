// Durable delete manifests in IndexedDB. Permanent delete wins until cleared.
import { getSyncState, setSyncState, writeSyncStateWithOutbox } from '$lib/db/idb';

const NOTE_IDB = 'scrapscache-idb-note-tombstones';
const LABEL_IDB = 'scrapscache-idb-label-tombstones';
const BOARD_IDB = 'scrapscache-idb-board-tombstones';
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

let noteCache: Tombstones | null = null;
let labelCache: Tombstones | null = null;
let boardCache: Tombstones | null = null;

export function resetTombstoneCaches(): void {
	noteCache = null;
	labelCache = null;
	boardCache = null;
}

export function readTombstones(): Tombstones {
	return { ...(noteCache ?? {}) };
}

export function readLabelTombstones(): Tombstones {
	return { ...(labelCache ?? {}) };
}

export function readBoardTombstones(): Tombstones {
	return { ...(boardCache ?? {}) };
}

export async function writeTombstones(tombstones: Tombstones): Promise<void> {
	noteCache = sanitize(tombstones);
	await setSyncState(NOTE_IDB, noteCache);
}

export async function writeLabelTombstones(
	tombstones: Tombstones,
	syncOutboxKeys: Iterable<string> = []
): Promise<void> {
	labelCache = sanitize(tombstones);
	await writeSyncStateWithOutbox([[LABEL_IDB, labelCache]], syncOutboxKeys);
}

export async function hydrateTombstones(): Promise<{
	notes: Tombstones;
	labels: Tombstones;
	boards: Tombstones;
}> {
	const [idbNotes, idbLabels, idbBoards] = await Promise.all([
		getSyncState<unknown>(NOTE_IDB),
		getSyncState<unknown>(LABEL_IDB),
		getSyncState<unknown>(BOARD_IDB)
	]);
	noteCache = sanitize(idbNotes);
	labelCache = sanitize(idbLabels);
	boardCache = sanitize(idbBoards);
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
