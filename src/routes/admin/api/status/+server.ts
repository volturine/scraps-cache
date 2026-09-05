import type { RequestHandler } from './$types';
import { adminStatusResponse, authorizeAdminApi } from '$lib/server/adminHttp';

export const GET: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	return adminStatusResponse();
};
