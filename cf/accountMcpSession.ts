import type { DurableObjectState } from '@cloudflare/workers-types';
import type { CloudflareBindings } from '../src/lib/server/cloudflare/env';
import { execute } from '../src/lib/server/cloudflare/d1';
import { hashMcpToken, resolveStoredMcpToken, type ResolvedMcpToken } from '../src/lib/mcp/token';
import { McpSession, type McpStorage } from '../src/lib/server/mcp/engine';
import { MCP_SESSION_IDLE_MS } from '../src/lib/server/mcp/idle';
import {
	mcpBearerToken,
	mcpJsonRpcResponse,
	mcpSseResponse,
	readMcpJsonBody
} from '../src/lib/server/mcp/transport';
import { parseMaxAccountBytes } from '../src/lib/server/syncQuota';
import { syncThroughCoordinator } from '../src/lib/server/cloudflare/coordinatorSync';

type TokenResolver = (token: string) => Promise<ResolvedMcpToken | null>;

export class AccountMcpSession {
	private session?: McpSession;
	private activeTokenHash?: string;

	constructor(
		private readonly state: DurableObjectState,
		private readonly env?: CloudflareBindings,
		private readonly injectedTokenResolver?: TokenResolver
	) {}

	private createStorage(): McpStorage {
		return {
			sync: async (accountId, cursor, uploads, deletions, downloadLimit) => {
				if (!this.env?.ACCOUNT_COORDINATOR) throw new Error('Sync storage is unavailable');
				return syncThroughCoordinator(this.env.ACCOUNT_COORDINATOR, {
					accountId,
					cursor,
					uploads,
					deletions,
					downloadLimit,
					maxAccountBytes: parseMaxAccountBytes(this.env.SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES)
				}) as ReturnType<McpStorage['sync']>;
			}
		};
	}

	private async resolveToken(token: string): Promise<ResolvedMcpToken | null> {
		if (this.injectedTokenResolver) return this.injectedTokenResolver(token);
		if (!this.env?.SCRAPSCACHE_DB) throw new Error('MCP token storage is unavailable');
		const tokenHash = hashMcpToken(token);
		const result = await execute(this.env.SCRAPSCACHE_DB, {
			sql: `SELECT token_hash AS tokenHash, account_id AS accountId,
				wrapped_sync_key AS wrappedSyncKey, created_at AS createdAt, expires_at AS expiresAt
				FROM mcp_tokens
				WHERE token_hash = ? AND expires_at > ?
					AND EXISTS (
						SELECT 1 FROM account_mcp_access
						WHERE account_mcp_access.account_id = mcp_tokens.account_id
					)`,
			args: [tokenHash, Date.now()]
		});
		const row = result.rows[0] as
			| {
					tokenHash: string;
					accountId: string;
					wrappedSyncKey: string;
					createdAt: number;
					expiresAt: number;
			  }
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

	private scheduleIdleReap(): void {
		void this.state.storage?.setAlarm?.(Date.now() + MCP_SESSION_IDLE_MS);
	}

	private clearSession(): void {
		this.session?.close();
		this.session = undefined;
		this.activeTokenHash = undefined;
		void this.state.storage?.deleteAlarm?.();
	}

	private async authenticate(request: Request): Promise<McpSession | null> {
		const token = mcpBearerToken(request);
		if (!token) return null;
		const resolved = await this.resolveToken(token);
		if (!resolved) {
			this.clearSession();
			return null;
		}
		return this.useSession(resolved);
	}

	async alarm(): Promise<void> {
		if (!this.session) return;
		if (Date.now() - this.session.lastActiveAt > MCP_SESSION_IDLE_MS) {
			this.clearSession();
			return;
		}
		this.scheduleIdleReap();
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method === 'DELETE') {
			this.clearSession();
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
		this.scheduleIdleReap();

		const url = new URL(request.url);
		if (request.method === 'GET') return mcpSseResponse(request, session, url);
		if (request.method !== 'POST') return new Response(null, { status: 405 });
		const parsed = await readMcpJsonBody(request);
		if (!parsed.ok) return parsed.response;
		return mcpJsonRpcResponse(session, parsed.body, url.pathname);
	}
}
