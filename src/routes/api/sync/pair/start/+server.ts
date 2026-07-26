import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { pairingSessions } from '$lib/server/pairingSessions';
import { readJsonBody } from '$lib/server/request';

export const POST: RequestHandler = async ({ request }) => {
	let body: { codeTag?: unknown; role?: unknown; publicKey?: unknown };
	try { body = await readJsonBody(request, 16_384) as typeof body; } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }
	if (typeof body.codeTag !== 'string' || !/^[0-9a-f]{64}$/.test(body.codeTag) || (body.role !== 'existing' && body.role !== 'new') || typeof body.publicKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.publicKey)) return json({ error: 'Invalid pairing request' }, { status: 400 });
	return json(pairingSessions.start(body.codeTag, body.role, body.publicKey));
};
