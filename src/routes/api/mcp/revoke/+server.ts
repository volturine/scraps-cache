import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';
import { getMcpOAuthStore } from '$lib/server/mcp/oauthStore';

export const POST: RequestHandler = async ({ request, platform }) => {
	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) {
		return json({ error: 'Unauthorized to revoke MCP tokens' }, { status: 401 });
	}

	const tokenHashes = await getMcpTokenStore().revokeAccount(accountId);
	await getMcpOAuthStore().revokeAccountCodes(accountId);
	await endMcpSessions(accountId, tokenHashes, platform);

	return json({ success: true, revokedAt: Date.now() });
};
