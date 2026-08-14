// Durable delete manifests in IndexedDB. Permanent delete wins until the
// tombstone is cleared. localStorage is only a first-paint cache during hydrate.
import { getSyncState, setSyncState } from '$lib/db/idb';

const NOTE_LS = 'gkc-note-tombstones';
const LABEL_LS = 'gkc-label-tombstones';
const NOTE_IDB = 'gkc-idb-note-tombstones';
const LABEL_IDB = 'gkc-idb-label-tombstones';
const BOARD_IDB = 'gkc-idb-board-tombstones';
const BOARDS_IDB = 'gkc-idb-kanban-boards';

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

export async function writeLabelTombstones(tombstones: Tombstones): Promise<void> {
	labelCache = sanitize(tombstones);
	await setSyncState(LABEL_IDB, labelCache);
	if (typeof localStorage !== 'undefined') localStorage.removeItem(LABEL_LS);
}

export async function writeBoardTombstones(tombstones: Tombstones): Promise<void> {
	boardCache = sanitize(tombstones);
	await setSyncState(BOARD_IDB, boardCache);
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
	if (!Object.keys(noteCache).length) noteCache = readLegacy(NOTE_LS);
	labelCache = sanitize(idbLabels);
	if (!Object.keys(labelCache).length) labelCache = readLegacy(LABEL_LS);
	boardCache = sanitize(idbBoards);
	await Promise.all([
		setSyncState(NOTE_IDB, noteCache),
		setSyncState(LABEL_IDB, labelCache),
		setSyncState(BOARD_IDB, boardCache)
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
	await setSyncState(BOARDS_IDB, boards);
}
