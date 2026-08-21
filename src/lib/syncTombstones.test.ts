import { beforeEach, describe, expect, it } from 'vitest';
import {
	hydrateTombstones,
	loadBoardsFromDevice,
	resetTombstoneCaches,
	saveBoardsToDevice,
	writeTombstones
} from './syncTombstones';

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

describe('tombstone hydration', () => {
	beforeEach(() => {
		localStorage.clear();
		resetTombstoneCaches();
	});

	it('does not re-import legacy tombstones after they were legitimately emptied', async () => {
		localStorage.setItem('gkc-note-tombstones', JSON.stringify({ 'note-1': 100 }));
		expect((await hydrateTombstones()).notes).toEqual({ 'note-1': 100 });

		await writeTombstones({});
		localStorage.setItem('gkc-note-tombstones', JSON.stringify({ 'note-1': 100 }));
		resetTombstoneCaches();

		expect((await hydrateTombstones()).notes).toEqual({});
	});
});
