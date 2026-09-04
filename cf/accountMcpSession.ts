import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CloudflareBindings } from '../src/lib/server/cloudflare/env';
import { execute } from '../src/lib/server/cloudflare/d1';
import {
	hashMcpToken,
	isMcpToken,
	resolveStoredMcpToken,
	type ResolvedMcpToken
} from '../src/lib/mcp/token';
import { McpSession, type McpStorage } from '../src/lib/server/mcp/engine';
import { handleJsonRpcMessage } from '../src/lib/server/mcp/protocol';

const MAX_REQUEST_BYTES = 1024 * 1024;
type TokenResolver = (token: string) => Promise<ResolvedMcpToken | null>;

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization');
	const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
	if (!match) return null;
	const token = match[1];
	return isMcpToken(token) ? token : null;
}

export class AccountMcpSession {
	private session?: McpSession;
	private activeTokenHash?: string;

	constructor(
		_state: DurableObjectState,
		private readonly env?: CloudflareBindings,
		private readonly injectedTokenResolver?: TokenResolver
	) {}

	private createStorage(): McpStorage {
		return {
			sync: async (accountId, cursor, uploads, deletions, downloadLimit) => {
				if (!this.env?.ACCOUNT_COORDINATOR) throw new Error('Sync storage is unavailable');
				const stub = this.env.ACCOUNT_COORDINATOR.get(
					this.env.ACCOUNT_COORDINATOR.idFromName(accountId)
				);
				const response = await stub.fetch('https://coordinator/sync', {
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
				if (!response.ok) {
					throw new Error(`Account coordinator sync failed with status ${response.status}`);
				}
				return response.json();
			}
		};
	}

	private async resolveToken(token: string): Promise<ResolvedMcpToken | null> {
		if (this.injectedTokenResolver) return this.injectedTokenResolver(token);
		if (!this.env?.SCRAPSCACHE_DB) throw new Error('MCP token storage is unavailable');
		const tokenHash = hashMcpToken(token);
		const result = await execute(this.env.SCRAPSCACHE_DB, {
			sql: `SELECT token_hash AS tokenHash, account_id AS accountId,
				wrapped_sync_key AS wrappedSyncKey, created_at AS createdAt
				FROM mcp_tokens WHERE token_hash = ?`,
			args: [tokenHash]
		});
		const row = result.rows[0] as
			| { tokenHash: string; accountId: string; wrappedSyncKey: string; createdAt: number }
			| undefined;
		return row ? resolveStoredMcpToken(token, row) : null;
	}

	private useSession(resolved: ResolvedMcpToken): McpSession {
		if (!this.session || this.activeTokenHash !== resolved.tokenHash) {
			this.session?.close();
			this.session = new McpSession(resolved.accountId, resolved.syncKey, this.createStorage());
			this.activeTokenHash = resolved.tokenHash;
		}
		this.session.touch();
		return this.session;
	}

	private async authenticate(request: Request): Promise<McpSession | null> {
		const token = bearerToken(request);
		if (!token) return null;
		const resolved = await this.resolveToken(token);
		if (!resolved) {
			this.session?.close();
			this.session = undefined;
			this.activeTokenHash = undefined;
			return null;
		}
		return this.useSession(resolved);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'DELETE') {
			this.session?.close();
			this.session = undefined;
			this.activeTokenHash = undefined;
			return new Response(null, { status: 204 });
		}

		let session: McpSession | null;
		try {
			session = await this.authenticate(request);
		} catch {
			return Response.json({ error: 'MCP token storage is unavailable' }, { status: 503 });
		}
		if (!session) {
			return Response.json(
				{ error: 'Missing, invalid, or revoked MCP bearer token' },
				{ status: 401 }
			);
		}

		const url = new URL(request.url);
		if (request.method === 'GET' || request.method === 'HEAD') {
			let interval: ReturnType<typeof setInterval> | undefined;
			let unsubscribe: (() => void) | undefined;
			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();
					const send = (event: string, data: string) => {
						try {
							controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
						} catch {
							// The abort handler performs cleanup.
						}
					};
					send('endpoint', `${url.origin}/api/mcp/messages`);
					interval = setInterval(() => send('ping', '{}'), 15_000);
					unsubscribe = session.addSseListener((event, data) => {
						send(event, typeof data === 'string' ? data : JSON.stringify(data));
						if (event === 'close') {
							if (interval) clearInterval(interval);
							unsubscribe?.();
							controller.close();
						}
					});
					request.signal.addEventListener(
						'abort',
						() => {
							if (interval) clearInterval(interval);
							unsubscribe?.();
							try {
								controller.close();
							} catch {
								// The stream may already be closed.
							}
						},
						{ once: true }
					);
				},
				cancel() {
					if (interval) clearInterval(interval);
					unsubscribe?.();
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

		if (request.method !== 'POST') return new Response(null, { status: 405 });
		const contentLength = Number(request.headers.get('content-length') ?? 0);
		if (contentLength > MAX_REQUEST_BYTES) {
			return Response.json({ error: 'MCP request body is too large' }, { status: 413 });
		}
		const rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
			return Response.json({ error: 'MCP request body is too large' }, { status: 413 });
		}
		let body: unknown;
		try {
			body = JSON.parse(rawBody);
		} catch {
			return Response.json(
				{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
				{ status: 400 }
			);
		}

		const response = await handleJsonRpcMessage(session, body);
		const legacySseMessage = url.pathname.endsWith('/messages');
		if (response === null) return new Response(null, { status: 202 });
		if (legacySseMessage) {
			if (Array.isArray(response)) {
				for (const item of response) session.broadcast('message', item);
			} else {
				session.broadcast('message', response);
			}
			return new Response(null, { status: 202 });
		}
		return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
	}
}
