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
});
