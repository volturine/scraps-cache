import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { sameSyncSecret } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { recordSqliteError } from '$lib/server/metrics';
import { wakeScheduler } from '$lib/server/wakeScheduler';
import {
	ACCOUNT_ID_RE,
	DEVICE_ID_RE,
	isPushSubscription,
	parseFireAt
} from '$lib/server/pushWakes';

const MAX_REQUEST_BYTES = 8_000;

/** Blind wake list: timestamps only. The relay never receives note ids or text. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = publicApiLimiter.check(`push-ip:${clientAddress(getClientAddress)}`, {
		capacity: 40,
		refillWindowMs: 60_000
	});
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);

	let body: {
		accountId?: unknown;
		authSecret?: unknown;
		deviceId?: unknown;
		subscription?: unknown;
		fireAt?: unknown;
	};
	try {
		body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (
		typeof body.accountId !== 'string' ||
		!ACCOUNT_ID_RE.test(body.accountId) ||
		typeof body.authSecret !== 'string' ||
		body.authSecret.length < 32 ||
		body.authSecret.length > 256
	) {
		return json({ error: 'Sync account credentials are required' }, { status: 400 });
	}
	if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) {
		return json({ error: 'A device id is required' }, { status: 400 });
	}
	if (!isPushSubscription(body.subscription)) {
		return json({ error: 'A push subscription is required' }, { status: 400 });
	}
	const fireAt = parseFireAt(body.fireAt, Date.now());
	if (!fireAt) return json({ error: 'Invalid wake times' }, { status: 400 });

	const accountLimit = publicApiLimiter.check(`push-account:${body.accountId}`, {
		capacity: 20,
		refillWindowMs: 60_000
	});
	if (!accountLimit.allowed) return rateLimitResponse(accountLimit);

	try {
		const store = getSyncStore();
		const credentialHash = store.getCredentialHash(body.accountId);
		if (!credentialHash || !sameSyncSecret(credentialHash, body.authSecret)) {
			return json({ error: 'Invalid sync account credentials' }, { status: 404 });
		}
		store.savePushDevice(
			body.accountId,
			{
				deviceId: body.deviceId,
				endpoint: body.subscription.endpoint,
				p256dh: body.subscription.keys.p256dh,
				auth: body.subscription.keys.auth
			},
			fireAt
		);
		wakeScheduler.start();
		return json({ ok: true, wakes: fireAt.length });
	} catch (error) {
		recordSqliteError(error);
		return json({ error: 'Push registration is temporarily unavailable' }, { status: 503 });
	}
};
