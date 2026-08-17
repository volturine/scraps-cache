import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { getOperatorSnapshot } from '$lib/server/operatorMonitor';

export const GET: RequestHandler = ({ request }) => {
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	return json(getOperatorSnapshot(), {
		headers: { 'cache-control': 'no-store' }
	});
};
