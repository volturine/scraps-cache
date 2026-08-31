import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { pairingSessions } from '$lib/server/pairingSessions';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { isPairingRole } from '$lib/pairingProtocol';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(`pair:${clientAddress(getClientAddress)}`, {
		capacity: 60,
		refillWindowMs: 60_000
	});
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: { codeTag?: unknown; role?: unknown; publicKey?: unknown };
	try {
		body = (await readJsonBody(request, 16_384)) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (
		typeof body.codeTag !== 'string' ||
		!/^[0-9a-f]{64}$/.test(body.codeTag) ||
		!isPairingRole(body.role) ||
		typeof body.publicKey !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(body.publicKey)
	)
		return json({ error: 'Invalid pairing request' }, { status: 400 });
	try {
		return json(pairingSessions.start(body.codeTag, body.role, body.publicKey));
	} catch {
		return json(
			{ error: 'Pairing rendezvous is busy' },
			{ status: 503, headers: { 'retry-after': '2' } }
		);
	}
};
