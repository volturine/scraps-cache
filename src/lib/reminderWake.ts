import { relayReminderWakes, type ReminderNote, type ReminderWake } from '$lib/reminderNotify';
import { syncStore, type SyncAccount } from '$lib/stores/sync.svelte';
import { uid } from '$lib/utils';

const DEVICE_KEY = 'scrapscache-push-device';
let cachedVapidKey: string | null = null;
let registeredDevice: { accountId: string; endpoint: string } | null = null;
let registrationFlight: { key: string; promise: Promise<boolean> } | null = null;
let publishedWakes: { accountId: string; revision: number; signature: string } | null = null;
let publishFlight: { key: string; promise: Promise<ReminderWake[] | null> } | null = null;

export function reminderPushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		typeof Notification !== 'undefined' &&
		'serviceWorker' in navigator &&
		'PushManager' in window
	);
}

export function reminderDeviceId(): string {
	if (typeof localStorage === 'undefined') return uid().padEnd(16, 'x');
	const existing = localStorage.getItem(DEVICE_KEY);
	if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
	const next = uid()
		.replace(/[^A-Za-z0-9_-]/g, 'x')
		.padEnd(16, 'x');
	localStorage.setItem(DEVICE_KEY, next);
	return next;
}

function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
	const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
	const raw = atob((publicKey + padding).replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

function sameKey(left: ArrayBuffer | null, right: Uint8Array<ArrayBuffer>): boolean {
	if (!left) return false;
	const bytes = new Uint8Array(left);
	return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

export async function preloadVapidPublicKey(): Promise<string | null> {
	if (cachedVapidKey) return cachedVapidKey;
	try {
		const response = await fetch('/api/sync/push/vapid');
		const vapid = (await response.json()) as { publicKey?: unknown };
		if (!response.ok || typeof vapid.publicKey !== 'string' || !vapid.publicKey) return null;
		cachedVapidKey = vapid.publicKey;
		return cachedVapidKey;
	} catch {
		return null;
	}
}

async function waitForRegistration(timeoutMs = 8_000): Promise<ServiceWorkerRegistration | null> {
	if (!reminderPushSupported()) return null;
	const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
	if (existing) return existing;
	return Promise.race([
		navigator.serviceWorker.ready.catch(() => null),
		new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
	]);
}

/** Subscribe from the explicit permission gesture; rotate subscriptions when VAPID changes. */
export async function ensurePushSubscription(): Promise<boolean> {
	if (!reminderPushSupported() || Notification.permission !== 'granted') return false;
	const registration = await waitForRegistration();
	if (!registration?.pushManager) return false;
	const publicKey = cachedVapidKey ?? (await preloadVapidPublicKey());
	if (!publicKey) return false;
	const expectedKey = applicationServerKey(publicKey);
	let subscription = await registration.pushManager.getSubscription();
	if (subscription && !sameKey(subscription.options.applicationServerKey, expectedKey)) {
		await subscription.unsubscribe().catch(() => false);
		subscription = null;
	}
	if (subscription) return true;
	try {
		await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: expectedKey
		});
		return true;
	} catch {
		return false;
	}
}

async function subscriptionBody(): Promise<{
	endpoint: string;
	keys: { p256dh: string; auth: string };
} | null> {
	if (!(await ensurePushSubscription())) return null;
	const registration = await waitForRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	const json = subscription?.toJSON();
	if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
	return {
		endpoint: json.endpoint,
		keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
	};
}

/** Register this account + push endpoint on the relay. No-op when already registered. */
export async function registerReminderDevice(): Promise<boolean> {
	const account = syncStore.account;
	if (!account) return false;
	const subscription = await subscriptionBody();
	if (!subscription) return false;
	if (
		registeredDevice?.accountId === account.accountId &&
		registeredDevice.endpoint === subscription.endpoint
	)
		return true;
	const key = `${account.accountId}\0${subscription.endpoint}`;
	if (registrationFlight?.key === key) return registrationFlight.promise;
	const promise = (async () => {
		try {
			const response = await syncStore.authorizedFetch('/api/sync/push/wakes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					deviceId: reminderDeviceId(),
					subscription
				})
			});
			if (response.ok)
				registeredDevice = { accountId: account.accountId, endpoint: subscription.endpoint };
			return response.ok;
		} catch {
			return false;
		}
	})();
	registrationFlight = { key, promise };
	return promise.finally(() => {
		if (registrationFlight?.promise === promise) registrationFlight = null;
	});
}

/** Make the relay wake list match this snapshot. No-op when it already does. */
export async function publishReminderWakes(notes: ReminderNote[]): Promise<ReminderWake[] | null> {
	const account = syncStore.account;
	if (!account) return null;
	const wakes = relayReminderWakes(notes, Date.now());
	const signature = JSON.stringify(wakes);
	const revision = await syncStore.committedRevision();
	if (revision === null) return null;
	if (
		publishedWakes?.accountId === account.accountId &&
		publishedWakes.revision === revision &&
		publishedWakes.signature === signature
	)
		return wakes;
	const key = `${account.accountId}\0${revision}\0${signature}`;
	if (publishFlight?.key === key) return publishFlight.promise;
	const promise = (async () => {
		try {
			const response = await syncStore.authorizedFetch('/api/sync/push/wakes', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					revision,
					wakes
				})
			});
			if (!response.ok) return null;
			publishedWakes = { accountId: account.accountId, revision, signature };
			return wakes;
		} catch {
			return null;
		}
	})();
	publishFlight = { key, promise };
	return promise.finally(() => {
		if (publishFlight?.promise === promise) publishFlight = null;
	});
}

export async function unregisterReminderDevice(account: SyncAccount | null): Promise<void> {
	if (reminderPushSupported()) {
		const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
		const subscription = await registration?.pushManager.getSubscription().catch(() => null);
		await subscription?.unsubscribe().catch(() => false);
	}
	if (!account) return;
	if (registeredDevice?.accountId === account.accountId) registeredDevice = null;
	if (publishedWakes?.accountId === account.accountId) publishedWakes = null;
	let response: Response;
	try {
		response = await syncStore.authorizedFetch(
			'/api/sync/push/wakes',
			{
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				keepalive: true,
				body: JSON.stringify({
					deviceId: reminderDeviceId()
				})
			},
			account
		);
	} catch (err) {
		throw new Error('Could not reach the relay to remove this device from reminder push', {
			cause: err
		});
	}
	if (!response.ok) {
		throw new Error(`The relay rejected this device's reminder push removal (${response.status})`);
	}
}
