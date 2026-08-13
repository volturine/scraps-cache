import { futureWakeTimes, type ReminderNote } from '$lib/reminderNotify';
import { syncStore } from '$lib/stores/sync.svelte';
import { uid } from '$lib/utils';

const DEVICE_KEY = 'gkc-push-device';
const SECRET_KEY = 'gkc-push-device-secret';

let cachedVapidKey: string | null = null;

function randomSecret(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	}
	return uid()
		.repeat(3)
		.replace(/[^A-Za-z0-9]/g, 'x')
		.slice(0, 64);
}

function deviceCredentials(): { deviceId: string; deviceSecret: string } {
	if (typeof localStorage === 'undefined') {
		return { deviceId: uid().padEnd(16, 'x'), deviceSecret: randomSecret() };
	}
	let deviceId = localStorage.getItem(DEVICE_KEY);
	if (!deviceId || !/^[A-Za-z0-9_-]{16,128}$/.test(deviceId)) {
		deviceId = uid()
			.replace(/[^A-Za-z0-9_-]/g, 'x')
			.padEnd(16, 'x');
		localStorage.setItem(DEVICE_KEY, deviceId);
	}
	let deviceSecret = localStorage.getItem(SECRET_KEY);
	if (!deviceSecret || deviceSecret.length < 32) {
		deviceSecret = randomSecret();
		localStorage.setItem(SECRET_KEY, deviceSecret);
	}
	return { deviceId, deviceSecret };
}

function applicationServerKey(publicKey: string): BufferSource {
	const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
	const raw = atob((publicKey + padding).replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
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
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
	const existing = await navigator.serviceWorker.getRegistration().catch(() => undefined);
	if (existing) return existing;
	return Promise.race([
		navigator.serviceWorker.ready.catch(() => null),
		new Promise<null>((resolve) => {
			setTimeout(() => resolve(null), timeoutMs);
		})
	]);
}

/** Subscribe in the same user-gesture as the permission prompt (required on iOS). */
export async function ensurePushSubscription(): Promise<boolean> {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
	const registration = await waitForRegistration();
	if (!registration?.pushManager) return false;
	if (await registration.pushManager.getSubscription()) return true;

	const publicKey = cachedVapidKey ?? (await preloadVapidPublicKey());
	if (!publicKey) return false;

	try {
		await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: applicationServerKey(publicKey)
		});
		return true;
	} catch {
		return false;
	}
}

/** Register this device for contentless reminder ticks. Sync login is optional. */
export async function syncReminderWakes(notes: ReminderNote[]): Promise<boolean> {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
	if (!(await ensurePushSubscription())) return false;

	const registration = await waitForRegistration();
	const subscription = await registration?.pushManager.getSubscription();
	const json = subscription?.toJSON();
	if (!json?.endpoint || !json.keys?.p256dh || !json.keys.auth) return false;

	const { deviceId, deviceSecret } = deviceCredentials();
	const account = syncStore.account;
	try {
		const response = await fetch('/api/sync/push/wakes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				deviceId,
				deviceSecret,
				...(account ? { accountId: account.accountId, authSecret: account.authSecret } : {}),
				subscription: {
					endpoint: json.endpoint,
					keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }
				},
				fireAt: futureWakeTimes(notes, Date.now())
			})
		});
		return response.ok;
	} catch {
		return false;
	}
}
