import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';
import { getOperatorSnapshot } from '$lib/server/operatorMonitor';

export const GET: RequestHandler = async ({ request, getClientAddress }) => {
	const limit = await checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	return json(await getOperatorSnapshot(), {
		headers: { 'cache-control': 'no-store' }
	});
};
