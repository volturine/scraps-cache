import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { retentionManager } from '$lib/server/retentionManager';

export const POST: RequestHandler = async ({ request }) => {
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	try {
		return json(await retentionManager.runNow(), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (error) {
		if (error instanceof Error && error.message === 'Account retention is not configured') {
			return json({ error: error.message }, { status: 400 });
		}
		return json({ error: 'Retention sweep failed' }, { status: 503 });
	}
};
