import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { runRetentionSweep } from '$lib/server/retentionSweep';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limit = await checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	try {
		return json(await runRetentionSweep({ force: true }), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch {
		return json({ error: 'Retention sweep failed' }, { status: 503 });
	}
};
