import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { pairingSessions } from '$lib/server/pairingSessions';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(
		`pair:${clientAddress(getClientAddress)}`,
		{ capacity: 60, refillWindowMs: 60_000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: { sessionId?: unknown; grant?: unknown };
	try {
		body = await readJsonBody(request, 16_384) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	const grant = body.grant as { ciphertext?: unknown } | undefined;
	if (typeof body.sessionId !== 'string' || body.sessionId.length > 128
		|| !grant || typeof grant.ciphertext !== 'string' || grant.ciphertext.length > 8_192
		|| !/^[A-Za-z0-9_-]+$/.test(grant.ciphertext)) {
		return json({ error: 'Invalid encrypted rendezvous grant' }, { status: 400 });
	}
	const result = pairingSessions.submitGrant(body.sessionId, { ciphertext: grant.ciphertext });
	return result.success
		? json({ ok: true })
		: json({ error: 'Rendezvous no longer active' }, { status: 404 });
};
