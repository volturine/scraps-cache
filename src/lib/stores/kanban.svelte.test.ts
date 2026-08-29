import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKanbanBoard } from '$lib/kanban';
import { getSyncOutboxKeys } from '$lib/db/idb';
import { loadBoardsFromDevice } from '$lib/syncTombstones';
import { KanbanStore } from './kanban.svelte';

describe('kanban persist during sync', () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it('does not persist boards to IndexedDB until a durable mutation', async () => {
		const store = new KanbanStore();
		store.selectBoard(store.boards[0].id);
		await tick();
		expect(await loadBoardsFromDevice(null)).toBeNull();
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('writes $state boards to IndexedDB without throwing DataCloneError', async () => {
		const store = new KanbanStore();
		await expect(store.persistSyncState()).resolves.toBeUndefined();
		const stored = await loadBoardsFromDevice<unknown>(null);
		expect(stored).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: store.boards[0].id,
					name: store.boards[0].name
				})
			])
		);
		expect(() => structuredClone(stored)).not.toThrow();
	});

	it('gives later same-millisecond board edits a newer version', async () => {
		localStorage.clear();
		vi.spyOn(Date, 'now').mockReturnValue(1_000);
		const store = new KanbanStore();
		const boardId = store.boards[0].id;
		store.renameBoard(boardId, 'First');
		store.renameBoard(boardId, 'Second');
		expect(store.boards[0]?.name).toBe('Second');
		expect(store.boards[0]?.updatedAt).toBe(1_002);
		await (store as unknown as { pendingDeviceWrites: Promise<void> }).pendingDeviceWrites;
		vi.restoreAllMocks();
	});

	it('keeps a newer localStorage board over a stale IndexedDB copy', async () => {
		const store = new KanbanStore();
		const base = store.boardsForSync()[0];
		store.boards = [{ ...base, name: 'stale', updatedAt: 1 }];
		await store.persistSyncState();
		store.boards = [{ ...base, name: 'from-ls', updatedAt: 2 }];
		await store.hydrateFromDevice();
		expect(store.boards[0]?.name).toBe('from-ls');
		expect((await loadBoardsFromDevice(store.boardsForSync()))[0]?.name).toBe('from-ls');
	});
});

describe('replaceWithCloud', () => {
	it('keeps the active board when it still exists in the cloud state', () => {
		const store = new KanbanStore();
		const kept = createKanbanBoard('Kept');
		const other = createKanbanBoard('Other');
		store.replaceWithCloud([other, kept]);
		store.selectBoard(kept.id);
		store.replaceWithCloud([kept, { ...other, name: 'Renamed' }]);
		expect(store.activeBoardId).toBe(kept.id);
		expect(store.boards.map((board) => board.name)).toEqual(['Kept', 'Renamed']);
	});

	it('falls back to the first board when the active board is gone', () => {
		const store = new KanbanStore();
		const kept = createKanbanBoard('Kept');
		store.replaceWithCloud([kept]);
		store.selectBoard(kept.id);
		store.replaceWithCloud([createKanbanBoard('Fresh')]);
		expect(store.activeBoardId).toBe(store.boards[0].id);
	});
});
