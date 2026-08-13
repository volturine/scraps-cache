import { MAX_WAKES_PER_DEVICE } from '$lib/server/syncStore';

const TWENTY_YEARS_MS = 20 * 365 * 24 * 60 * 60 * 1000;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const DEVICE_SECRET_RE = /^[A-Za-z0-9+/=_-]{32,256}$/;
const PUSH_KEY = /^[A-Za-z0-9_-]+={0,2}$/;

export type PushKeys = { p256dh: string; auth: string };
export type PushSubscriptionBody = { endpoint: string; keys: PushKeys };

export function isHttpsEndpoint(value: string): boolean {
	if (value.length < 16 || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function isPushSubscription(value: unknown): value is PushSubscriptionBody {
	if (!value || typeof value !== 'object') return false;
	const subscription = value as Partial<PushSubscriptionBody>;
	const keys = subscription.keys;
	return (
		typeof subscription.endpoint === 'string' &&
		isHttpsEndpoint(subscription.endpoint) &&
		!!keys &&
		typeof keys === 'object' &&
		typeof keys.p256dh === 'string' &&
		typeof keys.auth === 'string' &&
		keys.p256dh.length >= 16 &&
		keys.p256dh.length <= 256 &&
		keys.auth.length >= 8 &&
		keys.auth.length <= 128 &&
		PUSH_KEY.test(keys.p256dh) &&
		PUSH_KEY.test(keys.auth)
	);
}

export function parseFireAt(value: unknown, now: number): number[] | null {
	if (!Array.isArray(value) || value.length > MAX_WAKES_PER_DEVICE) return null;
	const times: number[] = [];
	for (const item of value) {
		if (typeof item !== 'number' || !Number.isSafeInteger(item)) return null;
		if (item <= now || item > now + TWENTY_YEARS_MS) continue;
		times.push(item);
	}
	return times;
}
