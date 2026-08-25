import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	publishReminderWakes,
	registerReminderDevice,
	unregisterReminderDevice
} from './reminderWake';
import { syncStore } from './stores/sync.svelte';
import { createSyncIdentity } from './syncPairing';

describe('reminder wake requests', () => {
	afterEach(() => {
		syncStore.account = null;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('does not publish an unchanged wake snapshot twice', async () => {
		syncStore.account = createSyncIdentity();
		vi.spyOn(syncStore, 'committedRevision').mockResolvedValue(3);
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
		vi.stubGlobal('fetch', fetchMock);
		const notes = [
			{
				id: 'reminder-note',
				title: 'Later',
				body: '',
				reminder: Date.now() + 60_000,
				archived: false,
				trashed: false
			}
		];

		expect(await publishReminderWakes(notes)).toHaveLength(1);
		expect(await publishReminderWakes(notes)).toHaveLength(1);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'PUT' })
		);
	});

	it('does not register the same push device after every sync', async () => {
		syncStore.account = createSyncIdentity();
		const key = new Uint8Array([1, 2, 3]);
		const subscription = {
			options: { applicationServerKey: key.buffer },
			toJSON: () => ({
				endpoint: 'https://push.example/device',
				keys: { p256dh: 'public-key', auth: 'auth-key' }
			})
		};
		const registration = {
			pushManager: {
				getSubscription: vi.fn(async () => subscription)
			}
		};
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: {
				getRegistration: vi.fn(async () => registration),
				ready: Promise.resolve(registration)
			}
		});
		const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			const path = String(input);
			return path.endsWith('/vapid')
				? new Response(JSON.stringify({ publicKey: 'AQID' }))
				: new Response(JSON.stringify({ ok: true }));
		});
		vi.stubGlobal('fetch', fetchMock);

		expect(await registerReminderDevice()).toBe(true);
		expect(await registerReminderDevice()).toBe(true);
		expect(
			fetchMock.mock.calls.filter(
				([input, init]) => String(input).endsWith('/wakes') && init?.method === 'POST'
			)
		).toHaveLength(1);
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
