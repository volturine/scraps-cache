import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getMcpSessionManager } from '$lib/server/mcp/sessionManager';
import { verifyMcpToken } from '$lib/mcp/token';

export const GET: RequestHandler = async ({ request, url, platform }) => {
	const authHeader = request.headers.get('Authorization') || '';
	let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
	if (!token) {
		token = url.searchParams.get('token') || '';
	}

	if (!token) {
		return json({ error: 'Missing MCP authorization token' }, { status: 401 });
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
			return json({ error: verified.error || 'Invalid token' }, { status: 401 });
		}
		const doId = env.ACCOUNT_MCP_SESSION.idFromName(verified.accountId);
		const stub = env.ACCOUNT_MCP_SESSION.get(doId);
		return stub.fetch(request);
	}

	const manager = getMcpSessionManager();
	let sessionInfo;
	try {
		sessionInfo = await manager.createSessionFromToken(token);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : 'Unauthorized';
		return json({ error: msg }, { status: 401 });
	}

	const { sessionId, session } = sessionInfo;
	let interval: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: string) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					// Stream closed
				}
			};

			const endpointUrl = `${url.origin}/api/mcp/messages?sessionId=${sessionId}`;
			send('endpoint', endpointUrl);

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
					// already closed
				}
			});
		},
		cancel() {
			if (interval) clearInterval(interval);
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
};
