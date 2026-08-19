import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadBoardsFromDevice, saveBoardsToDevice } from './syncTombstones';

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
		await expect(saveBoardsToDevice(proxied)).resolves.toBeUndefined();
		const stored = await loadBoardsFromDevice(null);
		expect(stored).toEqual(boards);
		expect(structuredClone(stored)).toEqual(boards);
	});
});
