import {
	MAX_WAKES_PER_ACCOUNT,
	WAKE_RETAIN_MS,
	type ReminderWakeInput
} from '$lib/server/syncStore';

const TWENTY_YEARS_MS = 20 * 365 * 24 * 60 * 60 * 1000;
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const WAKE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

const PUSH_KEY = /^[A-Za-z0-9_-]+={0,2}$/;

export type PushKeys = { p256dh: string; auth: string };
export type PushSubscriptionBody = { endpoint: string; keys: PushKeys };

function ipVersion(hostname: string): 4 | 6 | null {
	if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) {
		const octets = hostname.split('.');
		const valid = octets.every((octet) => {
			if (octet.length > 1 && octet.startsWith('0')) return false;
			const value = Number(octet);
			return Number.isInteger(value) && value >= 0 && value <= 255;
		});
		return valid ? 4 : null;
	}
	if (hostname.includes(':') && /^[0-9a-fA-F:.]+$/.test(hostname)) return 6;
	return null;
}

function isPrivateIp(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (ipVersion(normalized) === 4) {
		const [first, second] = normalized.split('.').map(Number);
		return (
			first === 0 ||
			first === 10 ||
			first === 127 ||
			(first === 100 && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 198 && (second === 18 || second === 19)) ||
			first >= 224
		);
	}
	if (ipVersion(normalized) === 6) {
		return (
			normalized === '::' ||
			normalized === '::1' ||
			normalized.startsWith('fc') ||
			normalized.startsWith('fd') ||
			normalized.startsWith('64:ff9b:') ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith('::ffff:')
		);
	}
	return false;
}

export function isHttpsEndpoint(value: string): boolean {
	if (value.length < 16 || value.length > 2048) return false;
	try {
		const url = new URL(value);
		const hostname = url.hostname.toLowerCase();
		return (
			url.protocol === 'https:' &&
			!url.username &&
			!url.password &&
			hostname !== 'localhost' &&
			!hostname.endsWith('.localhost') &&
			!isPrivateIp(hostname)
		);
	} catch {
		return false;
	}
}

/** Minimal DNS resolution surface the endpoint check depends on. */
export type EndpointResolver = (hostname: string) => Promise<Array<{ address: string }>>;

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

async function dohRecords(hostname: string, type: 'A' | 'AAAA'): Promise<string[]> {
	const response = await fetch(
		`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`,
		{ headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(4_000) }
	);
	if (!response.ok) throw new Error(`DoH lookup failed with ${response.status}`);
	const body = (await response.json()) as {
		Status?: number;
		Answer?: Array<{ type: number; data: string }>;
	};
	if (body.Status !== 0) throw new Error(`DoH lookup returned status ${body.Status}`);
	const recordType = type === 'A' ? 1 : 28;
	return (body.Answer ?? [])
		.filter((record) => record.type === recordType)
		.map((record) => record.data);
}

/** DNS-over-HTTPS keeps private-address rejection portable across Node and Workers. */
export const dohResolve: EndpointResolver = async (hostname) => {
	const [v4, v6] = await Promise.all([dohRecords(hostname, 'A'), dohRecords(hostname, 'AAAA')]);
	return [...v4, ...v6].map((address) => ({ address }));
};

/**
 * Endpoint hostnames must resolve to public addresses at registration time.
 * Literal-level checks alone cannot see DNS answers, so a name the registrant
 * controls could otherwise target private infrastructure at send time.
 */
export async function isPublicEndpoint(
	value: string,
	resolve: EndpointResolver = dohResolve
): Promise<boolean> {
	if (!isHttpsEndpoint(value)) return false;
	const hostname = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
	if (ipVersion(hostname)) return !isPrivateIp(hostname);
	try {
		const addresses = await resolve(hostname);
		return addresses.length > 0 && addresses.every(({ address }) => !isPrivateIp(address));
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

export function parseReminderWakes(value: unknown, now: number): ReminderWakeInput[] | null {
	if (!Array.isArray(value) || value.length > MAX_WAKES_PER_ACCOUNT) return null;
	const seen = new Set<string>();
	const wakes = new Map<string, ReminderWakeInput>();
	for (const item of value) {
		if (!item || typeof item !== 'object') return null;
		const wake = item as { id?: unknown; fireAt?: unknown };
		if (
			typeof wake.id !== 'string' ||
			!WAKE_ID_RE.test(wake.id) ||
			typeof wake.fireAt !== 'number' ||
			!Number.isSafeInteger(wake.fireAt)
		) {
			return null;
		}
		if (seen.has(wake.id)) return null;
		seen.add(wake.id);
		if (wake.fireAt <= now - WAKE_RETAIN_MS || wake.fireAt > now + TWENTY_YEARS_MS) continue;
		wakes.set(wake.id, { id: wake.id, fireAt: wake.fireAt });
	}
	return [...wakes.values()].sort(
		(left, right) => left.fireAt - right.fireAt || left.id.localeCompare(right.id)
	);
}
