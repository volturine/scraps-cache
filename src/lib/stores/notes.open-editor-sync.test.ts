import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity } from '$lib/syncPairing';
import { notesStore } from './notes.svelte';
import { syncStore } from './sync.svelte';

/**
 * Issue #86: opportunistic auto syncs (boot, editor open) are throttled by a
 * staleness window; manual syncs are never throttled.
 */
describe('auto sync staleness window', () => {
	beforeEach(() => {
		localStorage.clear();
		vi.restoreAllMocks();
		notesStore.notes = [];
		notesStore.labels = [];
		(notesStore as unknown as { lastAutoSyncAt: number }).lastAutoSyncAt = 0;
		syncStore.account = createSyncIdentity();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function mockRelay(requests: unknown[]): void {
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
	}

	it('collapses rapid editor opens into one sync', async () => {
		const requests: unknown[] = [];
		mockRelay(requests);

		await notesStore.syncWithCloud();
		await notesStore.syncWithCloud();
		await notesStore.syncWithCloud();

		expect(requests.length).toBe(2);
	});

	it('syncs again once the window has passed', async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		const requests: unknown[] = [];
		mockRelay(requests);

		await notesStore.syncWithCloud();
		clock.mockReturnValue(now + 30_000);
		await notesStore.syncWithCloud();

		expect(requests.length).toBe(4);
	});
});
