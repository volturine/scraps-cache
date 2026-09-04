import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getMcpSessionManager } from './sessionManager';
import { handleJsonRpcMessage } from './protocol';
import { extractAccountIdFromSessionId } from './engine';
import { verifyMcpToken } from '$lib/mcp/token';

export const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
	'Access-Control-Allow-Headers': '*'
};

export const handleMcpOptions: RequestHandler = async () => {
	return new Response(null, {
		status: 204,
		headers: CORS_HEADERS
	});
};

export const handleMcpGet: RequestHandler = async ({ request, url, platform }) => {
	const authHeader = request.headers.get('Authorization') || '';
	let token = authHeader.replace(/^Bearer\s+/i, '').trim();
	if (!token) {
		token = url.searchParams.get('token') || '';
	}

	if (!token) {
		return json(
			{ error: 'Missing MCP authorization token' },
			{ status: 401, headers: CORS_HEADERS }
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
		const verified = verifyMcpToken(token);
		if (!verified.valid || !verified.accountId) {
			return json(
				{ error: verified.error || 'Invalid token' },
				{ status: 401, headers: CORS_HEADERS }
			);
		}
		const doId = env.ACCOUNT_MCP_SESSION.idFromName(verified.accountId);
		const stub = env.ACCOUNT_MCP_SESSION.get(doId);
		return stub.fetch(request);
	}

	const manager = getMcpSessionManager();
	let sessionInfo: { sessionId: string; session: import('./engine').McpSession };
	try {
		sessionInfo = await manager.createSessionFromToken(token);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : 'Invalid token';
		return json({ error: msg }, { status: 401, headers: CORS_HEADERS });
	}

	const { sessionId, session } = sessionInfo;
	let interval: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start: (controller) => {
			const encoder = new TextEncoder();
			const send = (event: string, data: string) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					// stream closed
				}
			};

			send(
				'endpoint',
				`${url.origin}/api/mcp/messages?sessionId=${sessionId}&token=${encodeURIComponent(token)}`
			);

			interval = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					if (interval) clearInterval(interval);
				}
			}, 15000);

			const unsubscribe = session.addSseListener((event, data) => {
				send(event, typeof data === 'string' ? data : JSON.stringify(data));
			});

			request.signal.addEventListener('abort', () => {
				if (interval) clearInterval(interval);
				unsubscribe();
				try {
					controller.close();
				} catch {
					// ignore
				}
			});
		},
		cancel: () => {
			if (interval) clearInterval(interval);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
			...CORS_HEADERS
		}
	});
};

export const handleMcpPost: RequestHandler = async ({ request, url, platform }) => {
	const sessionId =
		url.searchParams.get('sessionId') || request.headers.get('Mcp-Session-Id') || '';
	const token =
		url.searchParams.get('token') ||
		request.headers
			.get('Authorization')
			?.replace(/^Bearer\s+/i, '')
			.trim() ||
		null;

	if (!sessionId && !token) {
		return json(
			{ error: 'Missing sessionId query parameter or authorization token' },
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
		const accountId = extractAccountIdFromSessionId(sessionId, token);
		if (!accountId) {
			return json({ error: 'Invalid sessionId or token' }, { status: 400, headers: CORS_HEADERS });
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
	let session = sessionId ? manager.getSession(sessionId) : undefined;
	if (!session && token) {
		try {
			const info = await manager.createSessionFromToken(token);
			session = info.session;
		} catch {
			// invalid token
		}
	}

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
	const headers = new Headers(CORS_HEADERS);
	headers.set('Content-Type', 'application/json');
	const currentSessionId = sessionId || `${session.accountId}.${crypto.randomUUID()}`;
	headers.set('Mcp-Session-Id', currentSessionId);

	if (response === null) {
		return new Response(null, { status: 204, headers });
	}

	session.broadcast('message', response);
	return new Response(JSON.stringify(response), { status: 200, headers });
};
