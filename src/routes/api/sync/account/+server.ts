import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { getSyncAuth } from '$lib/server/syncAuth';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';

export const DELETE: RequestHandler = async ({ request, getClientAddress, platform }) => {
	const limited = await getPublicApiLimiter().check(
		`delete-account:${clientAddress(getClientAddress)}`,
		{
			capacity: 5,
			refillWindowMs: 60 * 60 * 1000
		}
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Account could not be deleted' }, { status: 401 });
	try {
		const mcpTokenHashes = await getMcpTokenStore().revokeAccount(accountId);
		await endMcpSessions(accountId, mcpTokenHashes, platform);
		const store = getSyncStore();
		await store.deleteAccount(accountId);
		await getSyncAuth().revokeSyncSessions(accountId);
		return new Response(null, { status: 204 });
	} catch (error) {
		console.error('[sync] account deletion failed');
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
