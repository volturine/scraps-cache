import { env } from '$env/dynamic/private';
import webPushPkg from 'web-push';
import { getSyncStore } from '$lib/server/syncStore';
import type { DueWake } from '$lib/server/syncStore';

const webpush = ('default' in webPushPkg ? webPushPkg.default : webPushPkg) as typeof webPushPkg;

const META_PUBLIC = 'vapid-public-v1';
export const VAPID_PRIVATE_META_KEY = 'vapid-private-v1';

export type WakeSendResult = 'sent' | 'gone' | 'failed';

let warnedDefaultSubject = false;
let warnedKeyRegeneration = false;

function vapidSubject(): string {
	const subject = env.SCRAPSCACHE_VAPID_SUBJECT?.trim();
	if (subject && (/^mailto:/i.test(subject) || /^https:/i.test(subject))) return subject;
	const origin = env.SCRAPSCACHE_ORIGIN?.trim() || env.ORIGIN?.trim();
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

export function getVapidKeys(): { publicKey: string; privateKey: string } {
	const fromEnvPublic = env.SCRAPSCACHE_VAPID_PUBLIC_KEY?.trim();
	const fromEnvPrivate = env.SCRAPSCACHE_VAPID_PRIVATE_KEY?.trim();
	if (Boolean(fromEnvPublic) !== Boolean(fromEnvPrivate)) {
		throw new Error(
			'Both SCRAPSCACHE_VAPID_PUBLIC_KEY and SCRAPSCACHE_VAPID_PRIVATE_KEY are required'
		);
	}
	if (fromEnvPublic && fromEnvPrivate) {
		return { publicKey: fromEnvPublic, privateKey: fromEnvPrivate };
	}

	const store = getSyncStore();
	const storedPublic = store.getMeta(META_PUBLIC);
	const storedPrivate = store.getMeta(VAPID_PRIVATE_META_KEY);
	if (storedPublic && storedPrivate) {
		return { publicKey: storedPublic, privateKey: storedPrivate };
	}

	const generated = webpush.generateVAPIDKeys();
	store.setMeta(META_PUBLIC, generated.publicKey);
	store.setMeta(VAPID_PRIVATE_META_KEY, generated.privateKey);
	warnKeyRegeneration(store.countPushDevices());
	return generated;
}

export async function sendReminderTick(device: DueWake): Promise<WakeSendResult> {
	try {
		const keys = getVapidKeys();
		await webpush.sendNotification(
			{
				endpoint: device.endpoint,
				keys: { p256dh: device.p256dh, auth: device.auth }
			},
			JSON.stringify({ type: 'reminder-wake', id: device.wakeId, fireAt: device.fireAt }),
			{
				TTL: 86_400,
				timeout: 10_000,
				urgency: 'high',
				vapidDetails: {
					subject: vapidSubject(),
					publicKey: keys.publicKey,
					privateKey: keys.privateKey
				}
			}
		);
		return 'sent';
	} catch (error) {
		const status =
			error && typeof error === 'object' && 'statusCode' in error
				? Number((error as { statusCode?: number }).statusCode)
				: null;
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'reminder_wake_failed',
				status: Number.isFinite(status) ? status : null
			})
		);
		if (status === 404 || status === 410) return 'gone';
		return 'failed';
	}
}
