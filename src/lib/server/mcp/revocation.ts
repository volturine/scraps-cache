import { getDb, type Db } from '$lib/server/db';

export class McpRevocationStore {
	constructor(private readonly customDb?: Db) {}

	private get db(): Db {
		return this.customDb ?? getDb();
	}

	async isRevoked(accountId: string, tokenCreatedAt: number): Promise<boolean> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: 'SELECT revoked_before AS revokedBefore FROM mcp_revocations WHERE account_id = ?',
			args: [accountId]
		});
		const row = result.rows[0] as unknown as { revokedBefore: number } | undefined;
		if (!row) return false;
		return tokenCreatedAt <= Number(row.revokedBefore);
	}

	async revoke(accountId: string, now = Date.now()): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'INSERT INTO mcp_revocations(account_id, revoked_before) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET revoked_before = excluded.revoked_before',
			args: [accountId, now]
		});
	}

	async getRevokedBefore(accountId: string): Promise<number | null> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: 'SELECT revoked_before AS revokedBefore FROM mcp_revocations WHERE account_id = ?',
			args: [accountId]
		});
		const row = result.rows[0] as unknown as { revokedBefore: number } | undefined;
		return row ? Number(row.revokedBefore) : null;
	}
}

let singleton: McpRevocationStore | undefined;
export function getMcpRevocationStore(): McpRevocationStore {
	singleton ??= new McpRevocationStore();
	return singleton;
}

export function closeMcpRevocationStore(): void {
	singleton = undefined;
}
