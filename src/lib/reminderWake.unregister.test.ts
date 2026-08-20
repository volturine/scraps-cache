import { afterEach, describe, expect, it, vi } from 'vitest';
import { unregisterReminderDevice } from './reminderWake';

/**
 * Issue #85: the server-side device unsubscribe DELETE is best-effort.
 * Neither a rejected fetch nor a 5xx response changes the outcome the caller
 * observes, so a failed unsubscribe leaves the push registration on the
 * relay with no retry and no user-visible signal.
 */
describe('unregisterReminderDevice failure visibility', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const account = {
		syncKey: 'key',
		accountId: 'acct',
		authSecret: 'secret',
		pairingCode: ''
	};

	it('gives the caller no signal when the server rejects the unsubscribe', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
		vi.stubGlobal('Notification', { permission: 'default' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration: async () => undefined, ready: Promise.resolve() }
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(unregisterReminderDevice(account)).resolves.toBeUndefined();

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'DELETE' })
		);
	});

	it('gives the caller no signal when the request never leaves the device', async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		vi.stubGlobal('Notification', { permission: 'default' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration: async () => undefined, ready: Promise.resolve() }
		});
		vi.stubGlobal('fetch', fetchMock);

		await expect(unregisterReminderDevice(account)).resolves.toBeUndefined();
	});
});
