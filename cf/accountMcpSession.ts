import type { DurableObjectState } from '@cloudflare/workers-types';
import { McpSession } from '../src/lib/server/mcp/engine';
import { handleJsonRpcMessage } from '../src/lib/server/mcp/protocol';
import { verifyMcpToken } from '../src/lib/mcp/token';
import { getMcpRevocationStore } from '../src/lib/server/mcp/revocation';

export class AccountMcpSession {
	private session?: McpSession;

	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname.endsWith('/sse')) {
			const authHeader = request.headers.get('Authorization') || '';
			let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
			if (!token) {
				token = url.searchParams.get('token') || '';
			}

			const verified = verifyMcpToken(token);
			if (!verified.valid || !verified.accountId || !verified.syncKey || !verified.createdAt) {
				return Response.json({ error: verified.error || 'Unauthorized' }, { status: 401 });
			}

			const revocationStore = getMcpRevocationStore();
			if (await revocationStore.isRevoked(verified.accountId, verified.createdAt)) {
				return Response.json({ error: 'Token revoked' }, { status: 401 });
			}

			this.session = new McpSession(verified.accountId, verified.syncKey);
			const sessionId = `${verified.accountId}_${crypto.randomUUID()}`;

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

					// Initial endpoint event
					send('endpoint', `/api/mcp/messages?sessionId=${sessionId}`);

					// Keep-alive every 15s
					interval = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(': ping\n\n'));
						} catch {
							if (interval) clearInterval(interval);
						}
					}, 15000);

					const unsubscribe = this.session!.addSseListener((event, data) => {
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
					'X-Accel-Buffering': 'no'
				}
			});
		}

		if (url.pathname.endsWith('/messages')) {
			if (request.method !== 'POST') {
				return Response.json({ error: 'Method not allowed' }, { status: 405 });
			}

			if (!this.session) {
				return Response.json({ error: 'No active session or session expired' }, { status: 404 });
			}

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
					{ status: 400 }
				);
			}

			const response = await handleJsonRpcMessage(this.session, body);
			if (response) {
				this.session.broadcast('message', response);
				return Response.json(response, { status: 200 });
			}
			return new Response(null, { status: 202 });
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	}
}
