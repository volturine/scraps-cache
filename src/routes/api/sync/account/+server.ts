import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { sameSyncSecret } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const DELETE: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(
		`delete-account:${clientAddress(getClientAddress)}`,
		{ capacity: 5, refillWindowMs: 60 * 60 * 1000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: { accountId?: unknown; authSecret?: unknown };
	try {
		body = await readJsonBody(request, 16_384) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}
	if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId)
		|| typeof body.authSecret !== 'string' || body.authSecret.length < 32 || body.authSecret.length > 256) {
		return json({ error: 'Account could not be deleted' }, { status: 404 });
	}
	try {
		const store = getSyncStore();
		const credentialHash = store.getCredentialHash(body.accountId);
		if (!credentialHash || !sameSyncSecret(credentialHash, body.authSecret)) {
			return json({ error: 'Account could not be deleted' }, { status: 404 });
		}
		store.deleteAccount(body.accountId);
		return new Response(null, { status: 204 });
	} catch (error) {
		console.error('[sync] account deletion failed');
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
