import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getMcpAccessStore } from '$lib/server/mcp/accessStore';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';

export const GET: RequestHandler = async ({ request }) => {
	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Unauthorized' }, { status: 401 });
	const access = await getMcpAccessStore().get(accountId);
	return json(
		{
			...access,
			grants: access.enabled ? await getMcpTokenStore().listGrants(accountId) : []
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
