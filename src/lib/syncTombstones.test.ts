import { beforeEach, describe, expect, it } from 'vitest';
import {
	hydrateTombstones,
	loadBoardsFromDevice,
	resetTombstoneCaches,
	saveBoardsToDevice,
	writeTombstones
} from './syncTombstones';

const PID = 'device-local';

describe('kanban board persistence', () => {
	it('stores a structured-cloneable snapshot so reactive proxies cannot fail IndexedDB', async () => {
		const boards = [
			{
				id: 'board-1',
				name: 'Work',
				columns: [{ id: 'backlog', labelId: null }],
				backlogFilter: { mode: 'all-non-column', includeUntagged: true, labelIds: [] },
				updatedAt: 1
			}
		];
		const proxied = new Proxy(boards, {});
		await expect(saveBoardsToDevice(PID, proxied)).resolves.toBeUndefined();
		const stored = await loadBoardsFromDevice(PID, null);
		expect(stored).toEqual(boards);
		expect(structuredClone(stored)).toEqual(boards);
	});

	it('keeps namespaces separate per profile', async () => {
		await saveBoardsToDevice('p-one', [{ id: 'a', name: 'A' }]);
		await saveBoardsToDevice('p-two', [{ id: 'b', name: 'B' }]);
		expect(await loadBoardsFromDevice('p-one', null)).toEqual([{ id: 'a', name: 'A' }]);
		expect(await loadBoardsFromDevice('p-two', null)).toEqual([{ id: 'b', name: 'B' }]);
	});
});

describe('tombstone hydration', () => {
	beforeEach(() => {
		localStorage.clear();
		resetTombstoneCaches();
	});

	it('round-trips tombstones per profile and isolates them from each other', async () => {
		await writeTombstones('p-one', { 'note-1': 100 });
		resetTombstoneCaches();

		expect((await hydrateTombstones('p-one')).notes).toEqual({ 'note-1': 100 });
		expect((await hydrateTombstones('p-two')).notes).toEqual({});

		await writeTombstones('p-one', {});
		resetTombstoneCaches();
		expect((await hydrateTombstones('p-one')).notes).toEqual({});
	});
});
