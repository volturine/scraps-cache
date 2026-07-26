import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { pairingSessions } from '$lib/server/pairingSessions';
import { readJsonBody } from '$lib/server/request';

export const POST: RequestHandler = async ({ request }) => {
	let body: { sessionId?: unknown };
	try { body = await readJsonBody(request, 4_096) as typeof body; } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }
	if (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 128) return json({ error: 'Invalid pairing request' }, { status: 400 });
	return json(pairingSessions.poll(body.sessionId));
};
