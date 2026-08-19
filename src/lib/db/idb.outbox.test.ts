import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
	clearSyncOutbox,
	commitSyncControl,
	getSyncOutboxKeys,
	getSyncState,
	markSyncOutbox,
	setSyncState
} from './idb';

describe('durable sync outbox', () => {
	it('deduplicates keys and clears only acknowledged generations', async () => {
		await markSyncOutbox(['note:one', 'note:one', 'label:two']);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one'], 0);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one', 'label:two']);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('clears an internally marked generation without clearing a later edit', async () => {
		await markSyncOutbox(['note:one'], 100);
		await clearSyncOutbox(['note:one'], 99);
		expect(await getSyncOutboxKeys()).toEqual(['note:one']);

		await markSyncOutbox(['note:one'], 200);
		await clearSyncOutbox(['note:one'], 100);
		expect(await getSyncOutboxKeys()).toEqual(['note:one']);

		await clearSyncOutbox(['note:one'], 200);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});

	it('rolls back cursor and outbox changes together when a control write fails', async () => {
		await setSyncState('test-cursor', 4);
		await markSyncOutbox(['note:atomic'], 100);

		await expect(
			commitSyncControl(
				[
					['test-cursor', 5],
					['uncloneable-value', () => undefined]
				],
				[{ keys: ['note:atomic'], through: 100 }]
			)
		).rejects.toThrow();

		expect(await getSyncState('test-cursor')).toBe(4);
		expect(await getSyncOutboxKeys()).toEqual(['note:atomic']);
	});
});
