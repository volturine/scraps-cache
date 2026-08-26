import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';

export const GET: RequestHandler = () => {
	const ready = getSyncStore().isReady();
	return json({ ready }, { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
};
