import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '$lib/types';
import { createSyncIdentity, encryptSyncPayload } from '$lib/syncPairing';

const controlWrites: string[] = [];
const durabilityEvents: string[] = [];

vi.mock('$lib/db/idb', () => ({
	clearSyncOutbox: vi.fn(async () => undefined),
	deleteSyncState: vi.fn(async () => undefined),
	getSyncOutboxKeys: vi.fn(async () => []),
	getSyncState: vi.fn(async () => undefined),
	markSyncOutbox: vi.fn(async () => undefined),
	setSyncState: vi.fn(async (key: string) => {
		controlWrites.push(key);
		durabilityEvents.push(`control:${key}`);
	})
}));

import { SyncStore } from './sync.svelte';

function note(): Note {
	return {
		id: 'remote-note',
		title: 'remote',
		body: '',
		color: 'default',
		pinned: false,
		archived: false,
		trashed: false,
		trashedAt: null,
		createdAt: 1,
		updatedAt: 1,
		reminder: null,
		labels: [],
		images: []
	};
}

function remoteData(syncKey: string): Record<string, unknown> {
	return {
		cursor: 1,
		envelopes: [
			{
				seq: 1,
				id: 'remote-envelope',
				slot: 'a'.repeat(64),
				ciphertext: encryptSyncPayload(syncKey, { kind: 'note', value: note() })
			}
		],
		conflicts: [],
		hasMore: false,
		reset: false,
		writesAccepted: true
	};
}

describe('client sync durability', () => {
	beforeEach(() => {
		localStorage.clear();
		controlWrites.length = 0;
		durabilityEvents.length = 0;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('applies a downloaded page before committing its cursor', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		vi.spyOn(
			store as unknown as {
				sendSyncRequest(): Promise<{ success: boolean; data: Record<string, unknown> }>;
			},
			'sendSyncRequest'
		).mockResolvedValue({
			success: true,
			data: remoteData(account.syncKey)
		});
		const result = await store.sync([], [], {}, {}, [], {}, false, true, async (snapshot) => {
			durabilityEvents.push(`applied:${snapshot.notes[0]?.id}`);
			return snapshot;
		});

		expect(result.success, result.error).toBe(true);
		expect(durabilityEvents[0]).toBe('applied:remote-note');
		expect(durabilityEvents.findIndex((event) => event.includes('cursor'))).toBeGreaterThan(0);
	});

	it('does not advance control state when durable application fails', async () => {
		const account = createSyncIdentity();
		const store = new SyncStore();
		store.account = account;
		vi.spyOn(
			store as unknown as {
				sendSyncRequest(): Promise<{ success: boolean; data: Record<string, unknown> }>;
			},
			'sendSyncRequest'
		).mockResolvedValue({
			success: true,
			data: remoteData(account.syncKey)
		});

		const result = await store.sync([], [], {}, {}, [], {}, false, true, async () => {
			throw new Error('IndexedDB write failed');
		});

		expect(result).toMatchObject({ success: false });
		expect(controlWrites).toEqual([]);
	});
});
