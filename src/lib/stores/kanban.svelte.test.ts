import { describe, expect, it } from 'vitest';
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
