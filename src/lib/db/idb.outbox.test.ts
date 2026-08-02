import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { clearSyncOutbox, getSyncOutboxKeys, markSyncOutbox } from './idb';

describe('durable sync outbox', () => {
	it('deduplicates keys and clears only acknowledged generations', async () => {
		await markSyncOutbox(['note:one', 'note:one', 'label:two']);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one'], 0);
		expect((await getSyncOutboxKeys()).sort()).toEqual(['label:two', 'note:one']);

		await clearSyncOutbox(['note:one', 'label:two']);
		expect(await getSyncOutboxKeys()).toEqual([]);
	});
});
