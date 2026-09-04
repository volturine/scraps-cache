import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMcpSessionManager } from '$lib/server/mcp/sessionManager';
import { handleJsonRpcMessage } from '$lib/server/mcp/protocol';

export const POST: RequestHandler = async ({ request, url, platform }) => {
	const sessionId =
		url.searchParams.get('sessionId') || request.headers.get('Mcp-Session-Id') || '';
	if (!sessionId) {
		return json({ error: 'Missing sessionId query parameter' }, { status: 400 });
	}

	const env = (
		platform as
			| {
					env?: {
						ACCOUNT_MCP_SESSION?: {
							idFromName: (name: string) => unknown;
							get: (id: unknown) => { fetch: (req: Request) => Promise<Response> };
						};
					};
			  }
			| undefined
	)?.env;

	if (env?.ACCOUNT_MCP_SESSION) {
		const accountId = sessionId.split('_')[0];
		if (!accountId) {
			return json({ error: 'Invalid sessionId' }, { status: 400 });
		}
		const doId = env.ACCOUNT_MCP_SESSION.idFromName(accountId);
		const stub = env.ACCOUNT_MCP_SESSION.get(doId);
		return stub.fetch(request);
	}

	const manager = getMcpSessionManager();
	const session = manager.getSession(sessionId);
	if (!session) {
		return json({ error: 'Session not found or expired' }, { status: 404 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ status: 400 }
		);
	}

	const response = await handleJsonRpcMessage(session, body);
	if (response) {
		session.broadcast('message', response);
		return json(response);
	}

	return new Response(null, { status: 202 });
};
