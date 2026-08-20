import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity } from '$lib/syncPairing';
import { notesStore } from './notes.svelte';
import { syncStore } from './sync.svelte';

/**
 * Issue #86: `openEditor` in src/routes/+layout.svelte fires
 * `void notesStore.syncWithCloud()` on every editor open. Concurrent calls
 * collapse into one flight, but there is no staleness window: two sequential
 * opens always cost two full relay round-trips.
 */
describe('per-editor-open sync cost', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
		notesStore.notes = [];
		notesStore.labels = [];
		syncStore.account = createSyncIdentity();
	});

	it('issues a fresh relay request for every sequential editor open', async () => {
		const requests: unknown[] = [];
		vi.spyOn(
			syncStore as unknown as {
				sendSyncRequest(
					path: string,
					payload: string
				): Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>;
			},
			'sendSyncRequest'
		).mockImplementation(async (_path, payload) => {
			requests.push(JSON.parse(payload) as { cursor: number });
			return {
				success: true,
				data: {
					cursor: requests.length,
					envelopes: [],
					conflicts: [],
					hasMore: false,
					reset: false,
					writesAccepted: true
				}
			};
		});

		// Two notes opened back-to-back, each waiting for its sync to finish.
		// Measured: every open costs TWO relay round-trips (pull + ack pass),
		// with no staleness window between opens.
		await notesStore.syncWithCloud();
		await notesStore.syncWithCloud();

		expect(requests.length).toBe(4);
	});
});
