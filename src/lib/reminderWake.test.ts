import { afterEach, describe, expect, it, vi } from 'vitest';
import { unregisterReminderDevice } from './reminderWake';

describe('unregisterReminderDevice', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('does not wait for a service worker that never registers', async () => {
		const getRegistration = vi.fn(async () => undefined);
		const ready = new Promise<never>(() => {});
		vi.stubGlobal('Notification', { permission: 'default' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration, ready }
		});
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal('fetch', fetchMock);

		const started = Date.now();
		await unregisterReminderDevice({
			syncKey: 'key',
			accountId: 'acct',
			authSecret: 'secret',
			pairingCode: ''
		});
		expect(Date.now() - started).toBeLessThan(500);
		expect(getRegistration).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'DELETE', keepalive: true })
		);
	});
});
