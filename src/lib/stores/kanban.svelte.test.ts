const PID = 'device-local';
import { beforeEach, describe, expect, it } from 'vitest';
import { createKanbanBoard } from '$lib/kanban';
import { loadBoardsFromDevice } from '$lib/syncTombstones';
import { getSyncOutboxKeys } from '$lib/db/idb';
import { KanbanStore } from './kanban.svelte';

describe('kanban persist during sync', () => {
	beforeEach(() => localStorage.clear());

	it('writes $state boards to IndexedDB without throwing DataCloneError', async () => {
		const store = new KanbanStore();
		await expect(store.persistSyncState(PID)).resolves.toBeUndefined();
		const stored = await loadBoardsFromDevice<unknown>(PID, null);
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

	it('loads only the target profile boards instead of merging in-memory boards', async () => {
		const store = new KanbanStore();
		const first = createKanbanBoard('First profile');
		const second = createKanbanBoard('Second profile');
		store.boards = [first];
		await store.persistSyncState('first-profile', [`board:${first.id}`]);
		store.boards = [second];
		await store.persistSyncState('second-profile', [`board:${second.id}`]);

		store.boards = [first];
		await store.hydrateFromDevice('second-profile');

		expect(store.boards.map((board) => board.name)).toEqual(['Second profile']);
		expect(await getSyncOutboxKeys('second-profile')).toEqual([`board:${second.id}`]);
	});

	it('does not create or queue another board when reloading an existing namespace', async () => {
		const store = new KanbanStore();
		const existing = createKanbanBoard('Existing');
		await store.persistSyncState(PID);
		store.boards = [existing];
		await store.persistSyncState(PID);

		await store.hydrateFromDevice(PID);
		await store.hydrateFromDevice(PID);

		expect(store.boards.map((board) => board.id)).toEqual([existing.id]);
		expect(await getSyncOutboxKeys(PID)).toEqual([]);
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
