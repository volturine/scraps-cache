import { futureWakeTimes, type ReminderNote } from '$lib/reminderNotify';
import { syncStore } from '$lib/stores/sync.svelte';
import { uid } from '$lib/utils';

const DEVICE_KEY = 'gkc-push-device';

function deviceId(): string {
	if (typeof localStorage === 'undefined') return uid();
	const existing = localStorage.getItem(DEVICE_KEY);
	if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
	const next = uid()
		.replace(/[^A-Za-z0-9_-]/g, 'x')
		.padEnd(16, 'x');
	localStorage.setItem(DEVICE_KEY, next);
	return next;
}

function applicationServerKey(publicKey: string): BufferSource {
	const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
	const raw = atob((publicKey + padding).replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** Register this device for contentless reminder ticks. No-op without sync + permission + SW. */
export async function syncReminderWakes(notes: ReminderNote[]): Promise<boolean> {
	const account = syncStore.account;
	if (!account) return false;
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
	if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;

	const registration = await navigator.serviceWorker.ready.catch(() => undefined);
	if (!registration?.pushManager) return false;

	let vapid: { publicKey?: unknown };
	try {
		const response = await fetch('/api/sync/push/vapid');
		vapid = (await response.json()) as { publicKey?: unknown };
		if (!response.ok || typeof vapid.publicKey !== 'string' || !vapid.publicKey) return false;
	} catch {
		return false;
	}

	let subscription = await registration.pushManager.getSubscription();
	if (!subscription) {
		try {
			subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: applicationServerKey(vapid.publicKey)
			});
		} catch {
			return false;
		}
	}

	const json = subscription.toJSON();
	if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return false;

	try {
		const response = await fetch('/api/sync/push/wakes', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				accountId: account.accountId,
				authSecret: account.authSecret,
				deviceId: deviceId(),
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
