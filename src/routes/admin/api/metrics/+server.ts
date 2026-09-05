import type { RequestHandler } from '@sveltejs/kit';
import { adminMetricsResponse, authorizeAdminApi } from '$lib/server/adminHttp';

export const GET: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	return adminMetricsResponse();
};
