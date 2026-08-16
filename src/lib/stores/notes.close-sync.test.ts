import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSyncOutbox, getSyncOutboxKeys, markSyncOutbox } from '$lib/db/idb';
import { syncStore } from './sync.svelte';
import { notesStore } from './notes.svelte';

describe('syncing when a note closes', () => {
	beforeEach(async () => {
		await clearSyncOutbox(await getSyncOutboxKeys());
		syncStore.account = {
			syncKey: 'test-key',
			accountId: 'test-account',
			authSecret: 'test-secret',
			pairingCode: 'test-code'
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		syncStore.account = null;
		await clearSyncOutbox(await getSyncOutboxKeys());
	});

	it('skips the cloud request when there are no pending records', async () => {
		const flush = vi.spyOn(notesStore, 'flushSync').mockResolvedValue(true);

		expect(await notesStore.syncPendingChanges()).toBe(false);
		expect(flush).not.toHaveBeenCalled();
	});

	it('flushes the debounce immediately when a record is pending', async () => {
		await markSyncOutbox(['note:note-1']);
		const flush = vi.spyOn(notesStore, 'flushSync').mockResolvedValue(true);

		expect(await notesStore.syncPendingChanges()).toBe(true);
		expect(flush).toHaveBeenCalledOnce();
	});
});
