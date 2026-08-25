// Durable delete manifests and board state in IndexedDB, namespaced per profile.
// The module caches hold exactly one profile's data at a time; switching
// profiles resets them.
import { getSyncState, scopedStateKey, setSyncState } from '$lib/db/idb';

export const NOTE_IDB = 'gkc-idb-note-tombstones';
export const LABEL_IDB = 'gkc-idb-label-tombstones';
export const BOARD_IDB = 'gkc-idb-board-tombstones';
const MIGRATED_IDB = 'gkc-idb-tombstones-migrated';
export const BOARDS_IDB = 'gkc-idb-kanban-boards';

export type Tombstones = Record<string, number>;

function sanitize(value: unknown): Tombstones {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).flatMap(([id, at]) =>
			typeof id === 'string' && Number(at) > 0 ? [[id, Number(at)] as const] : []
		)
	);
}

let noteCache: Tombstones | null = null;
let labelCache: Tombstones | null = null;
let boardCache: Tombstones | null = null;
/** Which profile's data the caches hold; guards against stale reads after a switch. */
let cachePid: string | null = null;

export function resetTombstoneCaches(): void {
	noteCache = null;
	labelCache = null;
	boardCache = null;
	cachePid = null;
}

function cachesHold(pid: string): boolean {
	return cachePid === pid && noteCache !== null && labelCache !== null && boardCache !== null;
}

async function ensureHydrated(pid: string): Promise<void> {
	if (cachesHold(pid)) return;
	const [idbNotes, idbLabels, idbBoards] = await Promise.all([
		getSyncState<unknown>(scopedStateKey(NOTE_IDB, pid)),
		getSyncState<unknown>(scopedStateKey(LABEL_IDB, pid)),
		getSyncState<unknown>(scopedStateKey(BOARDS_IDB, pid))
	]);
	noteCache = sanitize(idbNotes);
	labelCache = sanitize(idbLabels);
	boardCache = sanitize(idbBoards);
	cachePid = pid;
}

async function persistCaches(pid: string): Promise<void> {
	await Promise.all([
		setSyncState(scopedStateKey(NOTE_IDB, pid), noteCache ?? {}),
		setSyncState(scopedStateKey(LABEL_IDB, pid), labelCache ?? {}),
		setSyncState(scopedStateKey(BOARD_IDB, pid), boardCache ?? {}),
		setSyncState(scopedStateKey(MIGRATED_IDB, pid), true)
	]);
}

export function readNoteTombstoneCache(): Tombstones {
	return { ...(noteCache ?? {}) };
}

export function readLabelTombstoneCache(): Tombstones {
	return { ...(labelCache ?? {}) };
}

export function readBoardTombstoneCache(): Tombstones {
	return { ...(boardCache ?? {}) };
}

export async function writeTombstones(pid: string, tombstones: Tombstones): Promise<void> {
	noteCache = sanitize(tombstones);
	cachePid = pid;
	await setSyncState(scopedStateKey(NOTE_IDB, pid), noteCache);
}

export async function writeLabelTombstones(pid: string, tombstones: Tombstones): Promise<void> {
	labelCache = sanitize(tombstones);
	cachePid = pid;
	await setSyncState(scopedStateKey(LABEL_IDB, pid), labelCache);
}

export async function writeBoardTombstones(pid: string, tombstones: Tombstones): Promise<void> {
	boardCache = sanitize(tombstones);
	cachePid = pid;
	await setSyncState(scopedStateKey(BOARD_IDB, pid), boardCache);
}

/** Load a profile's manifests and boards into the module caches. */
export async function hydrateTombstones(
	pid: string
): Promise<{ notes: Tombstones; labels: Tombstones; boards: Tombstones }> {
	await ensureHydrated(pid);
	await persistCaches(pid);
	return {
		notes: { ...(noteCache ?? {}) },
		labels: { ...(labelCache ?? {}) },
		boards: { ...(boardCache ?? {}) }
	};
}

export async function loadBoardsFromDevice<T>(pid: string, fallback: T): Promise<T> {
	const stored = await getSyncState<T>(scopedStateKey(BOARDS_IDB, pid));
	return stored ?? fallback;
}

export async function saveBoardsToDevice(pid: string, boards: unknown): Promise<void> {
	// `$state` board proxies throw DataCloneError in IndexedDB; JSON is already how
	// boards were serialized historically.
	await setSyncState(scopedStateKey(BOARDS_IDB, pid), JSON.parse(JSON.stringify(boards ?? [])));
}
