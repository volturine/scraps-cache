import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { exchangeSyncChallenge } from '$lib/server/syncAuth';
import { getSyncStore } from '$lib/server/syncStore';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(`auth-ip:${clientAddress(getClientAddress)}`, {
		capacity: 30,
		refillWindowMs: 60_000
	});
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: { accountId?: unknown; challengeId?: unknown; signature?: unknown };
	try {
		body = (await readJsonBody(request, 8_192)) as typeof body;
	} catch {
		return json({ error: 'Invalid request' }, { status: 400 });
	}
	if (
		typeof body.accountId !== 'string' ||
		typeof body.challengeId !== 'string' ||
		typeof body.signature !== 'string'
	) {
		return json({ error: 'Authentication failed' }, { status: 401 });
	}
	const publicKey = getSyncStore().getAuthCredential(body.accountId);
	const session =
		publicKey && exchangeSyncChallenge(body.accountId, publicKey, body.challengeId, body.signature);
	if (!session) return json({ error: 'Authentication failed' }, { status: 401 });
	return json(session);
};
