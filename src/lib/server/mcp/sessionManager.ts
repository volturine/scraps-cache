import { McpSession } from './engine';
import { verifyMcpToken } from '$lib/mcp/token';
import { getMcpRevocationStore } from './revocation';

const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class McpSessionManager {
	private sessions = new Map<string, McpSession>();
	private cleanupInterval?: ReturnType<typeof setInterval>;

	constructor(private readonly idleTimeoutMs = SESSION_IDLE_TIMEOUT_MS) {
		if (typeof setInterval !== 'undefined') {
			this.cleanupInterval = setInterval(() => this.pruneIdleSessions(), 60_000);
			if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') {
				this.cleanupInterval.unref();
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
		const session = new McpSession(verified.accountId, verified.syncKey);
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

	removeSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	pruneIdleSessions(now = Date.now()): void {
		for (const [id, session] of this.sessions.entries()) {
			if (now - session.lastActiveAt > this.idleTimeoutMs) {
				this.sessions.delete(id);
			}
		}
	}

	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = undefined;
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
	singleton?.destroy();
	singleton = undefined;
}
