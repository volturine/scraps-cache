import { McpSession, type McpStorage } from './engine';
import { getMcpTokenStore, type McpTokenStore } from './tokenStore';
import { getSyncStore } from '$lib/server/syncStore';
import { hashMcpToken, isMcpToken } from '$lib/mcp/token';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class McpSessionManager {
	private sessions = new Map<string, McpSession>();
	private reapTimer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
		private readonly tokenStore: Pick<McpTokenStore, 'resolve'> = getMcpTokenStore()
	) {
		this.startReaper();
	}

	private startReaper(): void {
		this.reapTimer = setInterval(() => {
			this.reapIdleSessions();
		}, 60 * 1000);
	}

	reapIdleSessions(): void {
		const now = Date.now();
		for (const [id, session] of this.sessions.entries()) {
			if (now - session.lastActiveAt > this.idleTimeoutMs) {
				session.close();
				this.sessions.delete(id);
			}
		}
	}

	pruneIdleSessions(olderThanMs = this.idleTimeoutMs): void {
		const now = Date.now();
		for (const [id, session] of this.sessions.entries()) {
			if (now - session.lastActiveAt > olderThanMs) {
				session.close();
				this.sessions.delete(id);
			}
		}
	}

	removeAccountSessions(accountId: string): void {
		for (const [id, session] of this.sessions.entries()) {
			if (session.accountId === accountId) {
				session.close();
				this.sessions.delete(id);
			}
		}
	}

	async getSessionFromToken(token: string): Promise<McpSession> {
		const resolved = await this.tokenStore.resolve(token);
		if (!resolved) {
			if (isMcpToken(token)) {
				const tokenHash = hashMcpToken(token);
				this.sessions.get(tokenHash)?.close();
				this.sessions.delete(tokenHash);
			}
			throw new Error('Invalid or revoked MCP token');
		}

		let session = this.sessions.get(resolved.tokenHash);
		if (session && Date.now() - session.lastActiveAt > this.idleTimeoutMs) {
			session.close();
			this.sessions.delete(resolved.tokenHash);
			session = undefined;
		}
		if (!session) {
			session = new McpSession(
				resolved.accountId,
				resolved.syncKey,
				getSyncStore() as unknown as McpStorage
			);
			this.sessions.set(resolved.tokenHash, session);
		}
		session.touch();
		return session;
	}

	close(): void {
		if (this.reapTimer) {
			clearInterval(this.reapTimer);
			this.reapTimer = undefined;
		}
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}
}

let singleton: McpSessionManager | undefined;
export function getMcpSessionManager(): McpSessionManager {
	singleton ??= new McpSessionManager();
	return singleton;
}

export function closeMcpSessionManager(): void {
	singleton?.close();
	singleton = undefined;
}
