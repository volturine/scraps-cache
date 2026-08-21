import { describe, expect, it } from 'vitest';
import { createKanbanBoard } from '$lib/kanban';
import { loadBoardsFromDevice } from '$lib/syncTombstones';
import { KanbanStore } from './kanban.svelte';

describe('kanban persist during sync', () => {
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
