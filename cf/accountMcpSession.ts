import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CloudflareBindings } from '../src/lib/server/cloudflare/env';
import { execute } from '../src/lib/server/cloudflare/d1';
import { McpSession, type McpStorage } from '../src/lib/server/mcp/engine';
import { handleJsonRpcMessage } from '../src/lib/server/mcp/protocol';
import { verifyMcpToken } from '../src/lib/mcp/token';

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': '*'
};

export class AccountMcpSession {
	private session?: McpSession;

	constructor(
		private readonly state: DurableObjectState,
		private readonly env?: CloudflareBindings
	) {}

	private createStorage(): McpStorage {
		return {
			sync: async (accountId, cursor, uploads, deletions, downloadLimit) => {
				if (!this.env?.ACCOUNT_COORDINATOR) {
					return {
						cursor: 0,
						envelopes: [],
						conflicts: [],
						hasMore: false,
						reset: false,
						writesAccepted: true
					};
				}
				const stub = this.env.ACCOUNT_COORDINATOR.get(
					this.env.ACCOUNT_COORDINATOR.idFromName(accountId)
				);
				const res = await stub.fetch('https://coordinator/sync', {
					method: 'POST',
					body: JSON.stringify({
						accountId,
						cursor,
						uploads,
						deletions,
						downloadLimit,
						maxAccountBytes: 1_000_000_000
					})
				});
				if (!res.ok) {
					throw new Error(`Account coordinator sync failed with status ${res.status}`);
				}
				return res.json();
			}
		};
	}

	private async isTokenRevoked(accountId: string, tokenCreatedAt: number): Promise<boolean> {
		if (!this.env?.SCRAPSCACHE_DB) return false;
		try {
			const result = await execute(this.env.SCRAPSCACHE_DB, {
				sql: 'SELECT revoked_before AS revokedBefore FROM mcp_revocations WHERE account_id = ?',
				args: [accountId]
			});
			const row = result.rows[0] as { revokedBefore?: number } | undefined;
			if (!row || row.revokedBefore == null) return false;
			return tokenCreatedAt <= Number(row.revokedBefore);
		} catch {
			return false;
		}
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				status: 204,
				headers: CORS_HEADERS
			});
		}

		const url = new URL(request.url);

		if (url.pathname.endsWith('/sse')) {
			const authHeader = request.headers.get('Authorization') || '';
			let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
			if (!token) {
				token = url.searchParams.get('token') || '';
			}

			const verified = verifyMcpToken(token);
			if (!verified.valid || !verified.accountId || !verified.syncKey || !verified.createdAt) {
				return Response.json(
					{ error: verified.error || 'Unauthorized' },
					{ status: 401, headers: CORS_HEADERS }
				);
			}

			if (await this.isTokenRevoked(verified.accountId, verified.createdAt)) {
				return Response.json({ error: 'Token revoked' }, { status: 401, headers: CORS_HEADERS });
			}

			this.session = new McpSession(verified.accountId, verified.syncKey, this.createStorage());
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

					// Initial endpoint event - absolute URL for MCP clients
					send('endpoint', `${url.origin}/api/mcp/messages?sessionId=${sessionId}`);

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
					'X-Accel-Buffering': 'no',
					...CORS_HEADERS
				}
			});
		}

		if (url.pathname.endsWith('/messages')) {
			if (request.method !== 'POST') {
				return Response.json(
					{ error: 'Method not allowed' },
					{ status: 405, headers: CORS_HEADERS }
				);
			}

			if (!this.session) {
				return Response.json(
					{ error: 'No active session or session expired' },
					{ status: 404, headers: CORS_HEADERS }
				);
			}

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json(
					{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
					{ status: 400, headers: CORS_HEADERS }
				);
			}

			const response = await handleJsonRpcMessage(this.session, body);
			if (response) {
				this.session.broadcast('message', response);
				return Response.json(response, { status: 200, headers: CORS_HEADERS });
			}
			return new Response(null, { status: 202, headers: CORS_HEADERS });
		}

		return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS });
	}
}
