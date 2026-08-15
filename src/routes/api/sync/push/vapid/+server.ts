import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getVapidKeys } from '$lib/server/webPush';

/** Public VAPID key for PushManager.subscribe. The private key never leaves the server. */
export const GET: RequestHandler = () => {
	try {
		return json({ publicKey: getVapidKeys().publicKey });
	} catch {
		return json({ error: 'Push is temporarily unavailable' }, { status: 503 });
	}
};
