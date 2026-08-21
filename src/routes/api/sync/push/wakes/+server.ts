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
	isPublicEndpoint,
	isPushSubscription,
	parseReminderWakes
} from '$lib/server/pushWakes';

const MAX_REQUEST_BYTES = 128_000;

type Credentials = { accountId?: unknown; authSecret?: unknown };

function validCredentials(body: Credentials): body is { accountId: string; authSecret: string } {
	return (
		typeof body.accountId === 'string' &&
		ACCOUNT_ID_RE.test(body.accountId) &&
		typeof body.authSecret === 'string' &&
		body.authSecret.length >= 32 &&
		body.authSecret.length <= 256
	);
}

async function authenticate(body: Credentials): Promise<{ accountId: string } | null> {
	if (!validCredentials(body)) return null;
	const credentialHash = getSyncStore().getCredentialHash(body.accountId);
	if (!credentialHash || !(await sameSyncSecret(credentialHash, body.authSecret))) return null;
	return { accountId: body.accountId };
}

function checkAddressLimit(getClientAddress: () => string) {
	return publicApiLimiter.check(`push-ip:${clientAddress(getClientAddress)}`, {
		capacity: 40,
		refillWindowMs: 60_000
	});
}

/** Register or refresh this device without changing the account wake snapshot. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = checkAddressLimit(getClientAddress);
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);
	let body: Credentials & { deviceId?: unknown; subscription?: unknown };
	try {
		body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) {
		return json({ error: 'A device id is required' }, { status: 400 });
	}
	if (!isPushSubscription(body.subscription)) {
		return json({ error: 'A push subscription is required' }, { status: 400 });
	}
	const account = await authenticate(body);
	if (!account) return json({ error: 'Invalid sync account credentials' }, { status: 404 });
	if (!(await isPublicEndpoint(body.subscription.endpoint))) {
		return json({ error: 'The push endpoint must be a public https origin' }, { status: 400 });
	}
	const deviceLimit = publicApiLimiter.check(`push-device:${body.deviceId}`, {
		capacity: 20,
		refillWindowMs: 60_000
	});
	if (!deviceLimit.allowed) return rateLimitResponse(deviceLimit);
	try {
		getSyncStore().savePushDevice({
			accountId: account.accountId,
			deviceId: body.deviceId,
			endpoint: body.subscription.endpoint,
			p256dh: body.subscription.keys.p256dh,
			auth: body.subscription.keys.auth
		});
		wakeScheduler.nudge();
		return json({ ok: true });
	} catch (error) {
		recordSqliteError(error);
		return json({ error: 'Push registration is temporarily unavailable' }, { status: 503 });
	}
};

/** Replace the account-wide opaque wake snapshot after client sync reconciliation. */
export const PUT: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = checkAddressLimit(getClientAddress);
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);
	let body: Credentials & { wakes?: unknown; revision?: unknown };
	try {
		body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const account = await authenticate(body);
	if (!account) return json({ error: 'Invalid sync account credentials' }, { status: 404 });
	const wakes = parseReminderWakes(body.wakes, Date.now());
	if (!wakes) return json({ error: 'Invalid reminder wakes' }, { status: 400 });
	if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) {
		return json({ error: 'A sync revision is required' }, { status: 400 });
	}
	try {
		const accepted = getSyncStore().replaceReminderWakes(
			account.accountId,
			wakes,
			Number(body.revision)
		);
		if (!accepted) return json({ error: 'Stale reminder snapshot' }, { status: 409 });
		wakeScheduler.nudge();
		return json({ ok: true, wakes: wakes.length });
	} catch (error) {
		recordSqliteError(error);
		return json({ error: 'Reminder scheduling is temporarily unavailable' }, { status: 503 });
	}
};

/** Stop deliveries for this browser while retaining other devices and account wakes. */
export const DELETE: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = checkAddressLimit(getClientAddress);
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);
	let body: Credentials & { deviceId?: unknown };
	try {
		body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (typeof body.deviceId !== 'string' || !DEVICE_ID_RE.test(body.deviceId)) {
		return json({ error: 'A device id is required' }, { status: 400 });
	}
	const account = await authenticate(body);
	if (!account) return json({ error: 'Invalid sync account credentials' }, { status: 404 });
	try {
		getSyncStore().deletePushDevice(account.accountId, body.deviceId);
		return new Response(null, { status: 204 });
	} catch (error) {
		recordSqliteError(error);
		return json({ error: 'Push registration is temporarily unavailable' }, { status: 503 });
	}
};
