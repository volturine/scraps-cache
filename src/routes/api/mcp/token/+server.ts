import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';
import { getMcpAccessStore } from '$lib/server/mcp/accessStore';

export const POST: RequestHandler = async ({ request, platform }) => {
	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getMcpAccessStore().isEnabled(accountId))) {
		return json({ error: 'Hosted MCP is not enabled for this account' }, { status: 403 });
	}
	if (Number(request.headers.get('content-length') ?? 0) > 2048) {
		return json({ error: 'Request body is too large' }, { status: 413 });
	}

	let body: { token?: unknown; wrappedSyncKey?: unknown };
	try {
		const rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).length > 2048) {
			return json({ error: 'Request body is too large' }, { status: 413 });
		}
		body = JSON.parse(rawBody) as typeof body;
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}
	if (typeof body.token !== 'string' || typeof body.wrappedSyncKey !== 'string') {
		return json({ error: 'Invalid MCP token grant' }, { status: 400 });
	}

	try {
		const { createdAt, expiresAt, replacedTokenHashes } = await getMcpTokenStore().issue(
			accountId,
			body.token,
			body.wrappedSyncKey
		);
		await endMcpSessions(accountId, replacedTokenHashes, platform);
		return json(
			{ success: true, createdAt, expiresAt },
			{ headers: { 'Cache-Control': 'no-store' } }
		);
	} catch {
		return json({ error: 'Invalid MCP token grant' }, { status: 400 });
	}
};
