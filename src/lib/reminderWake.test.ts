import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	publishReminderWakes,
	registerReminderDevice,
	unregisterReminderDevice
} from './reminderWake';
import { syncStore } from '$lib/stores/sync.svelte';
import { createSyncIdentity } from '$lib/syncPairing';

describe('reminder wake requests', () => {
	afterEach(() => {
		syncStore.account = null;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('does not publish an unchanged wake snapshot twice', async () => {
		syncStore.account = createSyncIdentity();
		vi.spyOn(syncStore, 'committedRevision').mockResolvedValue(3);
		const requestMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
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
		expect(requestMock).toHaveBeenCalledOnce();
		expect(requestMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'PUT' })
		);
	});

	it('publishes an unchanged wake snapshot again after the sync revision advances', async () => {
		syncStore.account = createSyncIdentity();
		let revision = 3;
		vi.spyOn(syncStore, 'committedRevision').mockImplementation(async () => revision);
		const requestMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));
		const notes = [
			{
				id: 'revision-reminder',
				title: 'Later',
				body: '',
				reminder: Date.now() + 60_000,
				archived: false,
				trashed: false
			}
		];

		expect(await publishReminderWakes(notes)).toHaveLength(1);
		revision = 4;
		expect(await publishReminderWakes(notes)).toHaveLength(1);
		expect(requestMock).toHaveBeenCalledTimes(2);
		const requests = requestMock.mock.calls;
		expect(JSON.parse(String(requests[1]?.[1]?.body)) as { revision: number }).toMatchObject({
			revision: 4
		});
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
				: new Response(null, { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const requestMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

		expect(await registerReminderDevice()).toBe(true);
		expect(await registerReminderDevice()).toBe(true);
		expect(
			requestMock.mock.calls.filter(
				([path, init]) => path === '/api/sync/push/wakes' && init?.method === 'POST'
			)
		).toHaveLength(1);
	});

	it('registers again when the push endpoint changes', async () => {
		syncStore.account = createSyncIdentity();
		const key = new Uint8Array([1, 2, 3]);
		const subscription = {
			options: { applicationServerKey: key.buffer },
			endpoint: 'https://push.example/device-a',
			toJSON: () => ({
				endpoint: 'https://push.example/device-a',
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
				: new Response(null, { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const requestMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(JSON.stringify({ ok: true })));

		expect(await registerReminderDevice()).toBe(true);
		subscription.endpoint = 'https://push.example/device-b';
		subscription.toJSON = () => ({
			endpoint: 'https://push.example/device-b',
			keys: { p256dh: 'public-key', auth: 'auth-key' }
		});
		expect(await registerReminderDevice()).toBe(true);
		expect(
			requestMock.mock.calls.filter(
				([path, init]) => path === '/api/sync/push/wakes' && init?.method === 'POST'
			)
		).toHaveLength(2);
	});

	it('does not wait for a service worker that never registers', async () => {
		const getRegistration = vi.fn(async () => undefined);
		const ready = new Promise<never>(() => {});
		vi.stubGlobal('Notification', { permission: 'default' });
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('navigator', {
			serviceWorker: { getRegistration, ready }
		});
		const fetchMock = vi
			.spyOn(syncStore, 'authorizedFetch')
			.mockResolvedValue(new Response(null, { status: 204 }));

		const started = Date.now();
		await unregisterReminderDevice({
			syncKey: 'key',
			accountId: 'acct',
			authPublicKey: 'secret',
			pairingCode: ''
		});
		expect(Date.now() - started).toBeLessThan(500);
		expect(getRegistration).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledWith(
			'/api/sync/push/wakes',
			expect.objectContaining({ method: 'DELETE', keepalive: true }),
			expect.any(Object)
		);
	});
});
