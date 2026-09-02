import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSecret } from '$lib/server/env';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { runCronTick } from '$lib/server/cronTick';

/** Scheduler entry point for Workers Cron Triggers and self-host crontabs. */
export const POST: RequestHandler = async ({ request }) => {
	const tickSecret = getSecret('SCRAPSCACHE_TICK_SECRET');
	if (!tickSecret) return unauthorizedAdminResponse();
	if (!isAdminAuthorized(request, tickSecret)) return unauthorizedAdminResponse();
	try {
		return json(await runCronTick(), { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		console.error(
			JSON.stringify({
				level: 'error',
				event: 'cron_tick_failed',
				message: error instanceof Error ? error.message : 'Cron tick failed'
			})
		);
		return json({ error: 'Cron tick failed' }, { status: 503 });
	}
};
