import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
export const POST: RequestHandler = async () =>
	json({ error: 'Use the simultaneous device rendezvous flow' }, { status: 410 });
