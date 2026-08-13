import { env } from '$env/dynamic/private';
import webPushPkg from 'web-push';
import { getSyncStore } from '$lib/server/syncStore';
import type { DueWake } from '$lib/server/syncStore';

const webpush = ('default' in webPushPkg ? webPushPkg.default : webPushPkg) as typeof webPushPkg;

const META_PUBLIC = 'vapid-public-v1';
const META_PRIVATE = 'vapid-private-v1';

export type WakeSendResult = 'sent' | 'gone' | 'failed';

function vapidSubject(): string {
	const subject = env.SHARD_VAPID_SUBJECT?.trim();
	if (subject && (/^mailto:/i.test(subject) || /^https:/i.test(subject))) return subject;
	const origin = env.SHARD_ORIGIN?.trim() || env.ORIGIN?.trim();
	if (origin && /^https:/i.test(origin)) return origin.replace(/\/$/, '');
	return 'mailto:shard@localhost';
}

export function getVapidKeys(): { publicKey: string; privateKey: string } {
	const fromEnvPublic = env.SHARD_VAPID_PUBLIC_KEY?.trim();
	const fromEnvPrivate = env.SHARD_VAPID_PRIVATE_KEY?.trim();
	if (fromEnvPublic && fromEnvPrivate) {
		return { publicKey: fromEnvPublic, privateKey: fromEnvPrivate };
	}

	const store = getSyncStore();
	const storedPublic = store.getMeta(META_PUBLIC);
	const storedPrivate = store.getMeta(META_PRIVATE);
	if (storedPublic && storedPrivate) {
		return { publicKey: storedPublic, privateKey: storedPrivate };
	}

	const generated = webpush.generateVAPIDKeys();
	store.setMeta(META_PUBLIC, generated.publicKey);
	store.setMeta(META_PRIVATE, generated.privateKey);
	return generated;
}

export async function sendReminderTick(device: DueWake): Promise<WakeSendResult> {
	const keys = getVapidKeys();
	try {
		await webpush.sendNotification(
			{
				endpoint: device.endpoint,
				keys: { p256dh: device.p256dh, auth: device.auth }
			},
			JSON.stringify({ type: 'reminder-tick' }),
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
