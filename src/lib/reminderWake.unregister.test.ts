import { afterEach, describe, expect, it, vi } from 'vitest';
import { unregisterReminderDevice } from './reminderWake';
import { syncStore } from '$lib/stores/sync.svelte';

/**
 * Issue #85: the server-side device unsubscribe must be observable. A failed
 * DELETE rejects so callers can surface it; success resolves.
 */
describe('unregisterReminderDevice failure visibility', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const account = {
		syncKey: 'key',
		accountId: 'acct',
		authPublicKey: 'secret',
		pairingCode: ''
	};

	function stubBrowser() {
		vi.stubGlobal('Notification', { permission: 'default' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration: async () => undefined, ready: Promise.resolve() }
		});
	}

	it('resolves when the relay accepts the unsubscribe', async () => {
		stubBrowser();
		const fetchMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(null, { status: 204 }));

		await expect(unregisterReminderDevice(account)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'DELETE', keepalive: true }),
			account
		);
	});

	it('rejects when the relay rejects the unsubscribe', async () => {
		stubBrowser();
		vi.spyOn(syncStore, 'authorizedFetch').mockResolvedValue(new Response(null, { status: 500 }));

		await expect(unregisterReminderDevice(account)).rejects.toThrow(/500/);
	});

	it('rejects when the request never leaves the device', async () => {
		stubBrowser();
		vi.spyOn(syncStore, 'authorizedFetch').mockRejectedValue(new TypeError('Failed to fetch'));

		await expect(unregisterReminderDevice(account)).rejects.toThrow(/relay/);
	});
});
