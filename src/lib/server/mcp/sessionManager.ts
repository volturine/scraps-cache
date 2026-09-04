import { McpSession, type McpStorage } from './engine';
import { verifyMcpToken } from '$lib/mcp/token';
import { getMcpRevocationStore } from './revocation';
import { getSyncStore } from '$lib/server/syncStore';

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class McpSessionManager {
	private sessions = new Map<string, McpSession>();
	private reapTimer?: ReturnType<typeof setInterval>;

	constructor(private readonly idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS) {
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
				this.sessions.delete(id);
			}
		}
	}

	pruneIdleSessions(olderThanMs = this.idleTimeoutMs): void {
		const now = Date.now();
		for (const [id, session] of this.sessions.entries()) {
			if (now - session.lastActiveAt > olderThanMs) {
				this.sessions.delete(id);
			}
		}
	}

	removeAccountSessions(accountId: string): void {
		for (const [id, session] of this.sessions.entries()) {
			if (session.accountId === accountId) {
				this.sessions.delete(id);
			}
		}
	}

	async createSessionFromToken(token: string): Promise<{ sessionId: string; session: McpSession }> {
		const verified = verifyMcpToken(token);
		if (!verified.valid || !verified.accountId || !verified.syncKey || !verified.createdAt) {
			throw new Error(verified.error || 'Invalid or malformed MCP token');
		}

		const revocationStore = getMcpRevocationStore();
		const isRevoked = await revocationStore.isRevoked(verified.accountId, verified.createdAt);
		if (isRevoked) {
			throw new Error('MCP token has been revoked');
		}

		const sessionId = crypto.randomUUID();
		const session = new McpSession(
			verified.accountId,
			verified.syncKey,
			getSyncStore() as unknown as McpStorage
		);
		this.sessions.set(sessionId, session);
		return { sessionId, session };
	}

	getSession(sessionId: string): McpSession | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) return undefined;

		if (Date.now() - session.lastActiveAt > this.idleTimeoutMs) {
			this.sessions.delete(sessionId);
			return undefined;
		}

		session.touch();
		return session;
	}

	removeSession(sessionId: string): boolean {
		return this.sessions.delete(sessionId);
	}

	close(): void {
		if (this.reapTimer) {
			clearInterval(this.reapTimer);
			this.reapTimer = undefined;
		}
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
