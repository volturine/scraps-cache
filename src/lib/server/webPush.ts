import { getSecret } from '$lib/server/env';
import webPushPkg from 'web-push';
import { getMeta, getDb, setMetaIfAbsent, type Db } from '$lib/server/db';
import { getSyncStore, type DueWake } from '$lib/server/syncStore';

const webpush = ('default' in webPushPkg ? webPushPkg.default : webPushPkg) as typeof webPushPkg;

export const VAPID_KEY_PAIR_META_KEY = 'vapid-key-pair-v1';

export type WakeSendResult = 'sent' | 'gone' | 'failed';

let warnedDefaultSubject = false;
let warnedKeyRegeneration = false;

function vapidSubject(): string {
	const subject = getSecret('SCRAPSCACHE_VAPID_SUBJECT')?.trim();
	if (subject && (/^mailto:/i.test(subject) || /^https:/i.test(subject))) return subject;
	const origin = getSecret('SCRAPSCACHE_ORIGIN')?.trim() || getSecret('ORIGIN')?.trim();
	if (origin && /^https:/i.test(origin)) return origin.replace(/\/$/, '');
	if (!warnedDefaultSubject) {
		warnedDefaultSubject = true;
		console.warn(
			JSON.stringify({
				level: 'warn',
				event: 'vapid_subject_default',
				message: 'SCRAPSCACHE_VAPID_SUBJECT is not configured; using placeholder mailto subject'
			})
		);
	}
	return 'mailto:scrapscache@localhost';
}

function warnKeyRegeneration(registeredDevices: number): void {
	if (warnedKeyRegeneration || registeredDevices === 0) return;
	warnedKeyRegeneration = true;
	console.warn(
		JSON.stringify({
			level: 'warn',
			event: 'vapid_key_regenerated',
			message:
				'VAPID signing key was regenerated while push devices are registered; existing push subscriptions are invalidated and devices must re-register',
			registeredDevices
		})
	);
}

function parseVapidKeyPair(value: string): { publicKey: string; privateKey: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Stored VAPID key pair is invalid');
	}
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		typeof (parsed as { publicKey?: unknown }).publicKey !== 'string' ||
		typeof (parsed as { privateKey?: unknown }).privateKey !== 'string' ||
		(parsed as { publicKey: string }).publicKey.length === 0 ||
		(parsed as { privateKey: string }).privateKey.length === 0
	) {
		throw new Error('Stored VAPID key pair is invalid');
	}
	return parsed as { publicKey: string; privateKey: string };
}

export async function getVapidKeys(
	db: Db = getDb()
): Promise<{ publicKey: string; privateKey: string }> {
	await db.ready;
	const fromEnvPublic = getSecret('SCRAPSCACHE_VAPID_PUBLIC_KEY')?.trim();
	const fromEnvPrivate = getSecret('SCRAPSCACHE_VAPID_PRIVATE_KEY')?.trim();
	if (Boolean(fromEnvPublic) !== Boolean(fromEnvPrivate)) {
		throw new Error(
			'Both SCRAPSCACHE_VAPID_PUBLIC_KEY and SCRAPSCACHE_VAPID_PRIVATE_KEY are required'
		);
	}
	if (fromEnvPublic && fromEnvPrivate) {
		return { publicKey: fromEnvPublic, privateKey: fromEnvPrivate };
	}

	const stored = await getMeta(db, VAPID_KEY_PAIR_META_KEY);
	if (stored) return parseVapidKeyPair(stored);

	const generated = webpush.generateVAPIDKeys();
	const candidate = JSON.stringify(generated);
	const persisted = await setMetaIfAbsent(db, VAPID_KEY_PAIR_META_KEY, candidate);
	if (persisted === candidate) {
		warnKeyRegeneration(await getSyncStore().countPushDevices());
	}
	return parseVapidKeyPair(persisted);
}

/** Web Push delivery via `generateRequestDetails` + `fetch`: the web-push crypto
 * pipeline runs on both Node and Workers, but its `https.request` transport does
 * not exist under workerd. */
export async function sendReminderTick(device: DueWake): Promise<WakeSendResult> {
	try {
		const keys = await getVapidKeys();
		const details = webpush.generateRequestDetails(
			{
				endpoint: device.endpoint,
				keys: { p256dh: device.p256dh, auth: device.auth }
			},
			JSON.stringify({ type: 'reminder-wake', id: device.wakeId, fireAt: device.fireAt }),
			{
				TTL: 86_400,
				urgency: 'high',
				vapidDetails: {
					subject: vapidSubject(),
					publicKey: keys.publicKey,
					privateKey: keys.privateKey
				}
			}
		);
		const headers = { ...details.headers } as Record<string, string>;
		delete headers['Content-Length'];
		delete headers['content-length'];
		const response = await fetch(details.endpoint, {
			method: details.method,
			headers,
			body: details.body ? new Uint8Array(details.body) : undefined,
			signal: AbortSignal.timeout(10_000)
		});
		if (response.ok) return 'sent';
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'reminder_wake_failed',
				status: response.status
			})
		);
		if (response.status === 404 || response.status === 410) return 'gone';
		return 'failed';
	} catch (error) {
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'reminder_wake_failed',
				status: null,
				message: error instanceof Error ? error.message : 'Web Push delivery failed'
			})
		);
		return 'failed';
	}
}
