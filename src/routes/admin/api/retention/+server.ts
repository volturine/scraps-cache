import type { RequestHandler } from '@sveltejs/kit';
import { authorizeAdminApi, retentionSweepResponse } from '$lib/server/adminHttp';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	return retentionSweepResponse();
};
