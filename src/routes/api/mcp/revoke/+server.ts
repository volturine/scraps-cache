import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMcpRevocationStore } from '$lib/server/mcp/revocation';
import { getSyncAuth } from '$lib/server/syncAuth';
import { verifyMcpToken } from '$lib/mcp/token';
import { getMcpSessionManager } from '$lib/server/mcp/sessionManager';

export const POST: RequestHandler = async ({ request }) => {
	let accountId: string | null = null;

	try {
		accountId = await getSyncAuth().authenticateSyncRequest(request);
	} catch {
		// Not authenticated via sync session
	}

	if (!accountId) {
		try {
			const body = (await request.json()) as { token?: string };
			if (body.token) {
				const verified = verifyMcpToken(body.token);
				if (verified.valid && verified.accountId) {
					accountId = verified.accountId;
				}
			}
		} catch {
			// Ignore
		}
	}

	if (!accountId) {
		return json({ error: 'Unauthorized to revoke MCP tokens' }, { status: 401 });
	}

	const revocationStore = getMcpRevocationStore();
	await revocationStore.revoke(accountId);

	const manager = getMcpSessionManager();
	manager.pruneIdleSessions(Date.now() + 1000 * 60 * 60 * 24);

	return json({ success: true, revokedAt: Date.now() });
};
