import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getMcpAccessStore } from '$lib/server/mcp/accessStore';

export const GET: RequestHandler = async ({ request }) => {
	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Unauthorized' }, { status: 401 });
	return json(await getMcpAccessStore().get(accountId), {
		headers: { 'cache-control': 'no-store' }
	});
};
