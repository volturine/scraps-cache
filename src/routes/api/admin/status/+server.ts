import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';
import { getOperatorSnapshot } from '$lib/server/operatorMonitor';

export const GET: RequestHandler = ({ request, getClientAddress }) => {
	const limit = checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	return json(getOperatorSnapshot(), {
		headers: { 'cache-control': 'no-store' }
	});
};
