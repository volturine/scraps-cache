import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMcpSessionManager } from '$lib/server/mcp/sessionManager';
import { handleJsonRpcMessage } from '$lib/server/mcp/protocol';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': '*'
};

export const OPTIONS: RequestHandler = async () => {
	return new Response(null, {
		status: 204,
		headers: CORS_HEADERS
	});
};

export const POST: RequestHandler = async ({ request, url, platform }) => {
	const sessionId =
		url.searchParams.get('sessionId') || request.headers.get('Mcp-Session-Id') || '';
	if (!sessionId) {
		return json(
			{ error: 'Missing sessionId query parameter' },
			{ status: 400, headers: CORS_HEADERS }
		);
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
			return json({ error: 'Invalid sessionId' }, { status: 400, headers: CORS_HEADERS });
		}
		const doId = env.ACCOUNT_MCP_SESSION.idFromName(accountId);
		const stub = env.ACCOUNT_MCP_SESSION.get(doId);
		const res = await stub.fetch(request);
		const headers = new Headers(res.headers);
		headers.set('Access-Control-Allow-Origin', '*');
		return new Response(res.body, {
			status: res.status,
			statusText: res.statusText,
			headers
		});
	}

	const manager = getMcpSessionManager();
	const session = manager.getSession(sessionId);
	if (!session) {
		return json({ error: 'Session not found or expired' }, { status: 404, headers: CORS_HEADERS });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ status: 400, headers: CORS_HEADERS }
		);
	}

	const response = await handleJsonRpcMessage(session, body);
	if (response) {
		session.broadcast('message', response);
		return json(response, { headers: CORS_HEADERS });
	}

	return new Response(null, { status: 202, headers: CORS_HEADERS });
};
