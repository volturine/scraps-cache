import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { backupManager } from '$lib/server/backupManager';

export const POST: RequestHandler = async ({ request }) => {
	const expected = env.SCRAPS_CACHE_ADMIN_TOKEN;
	if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
		return new Response(null, { status: 404 });
	}
	try {
		return json(await backupManager.runNow());
	} catch {
		return json({ error: 'Backup failed' }, { status: 503 });
	}
};
