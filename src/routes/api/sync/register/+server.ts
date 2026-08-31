import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { verifySyncRegistration } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(
		`register:${clientAddress(getClientAddress)}`,
		// Two immediately, then five tokens per hour.
		{ capacity: 2, refillWindowMs: 24 * 60 * 1000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: { accountId?: unknown; authPublicKey?: unknown; signature?: unknown };
	try {
		body = (await readJsonBody(request, 16_384)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId)) {
		return json({ error: 'Invalid account identity' }, { status: 400 });
	}
	if (
		typeof body.authPublicKey !== 'string' ||
		typeof body.signature !== 'string' ||
		!verifySyncRegistration(body.accountId, body.authPublicKey, body.signature)
	) {
		return json({ error: 'Invalid account credential' }, { status: 400 });
	}
	try {
		const created = getSyncStore().createAccount(body.accountId, body.authPublicKey);
		if (!created)
			return json({ error: 'This sync account already exists on this device.' }, { status: 409 });
		return json({ accountId: body.accountId });
	} catch (err) {
		console.error('[sync] register failed:', err);
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
