import { getDb, type Db } from '$lib/server/db';

export type McpAccountAccess = {
	enabled: boolean;
	enabledAt: number | null;
	updatedAt: number | null;
};

export class McpAccessStore {
	constructor(private readonly db: Db = getDb()) {}

	async get(accountId: string): Promise<McpAccountAccess> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT enabled_at AS enabledAt, updated_at AS updatedAt
				FROM account_mcp_access WHERE account_id = ?`,
			args: [accountId]
		});
		const row = result.rows[0] as unknown as { enabledAt: number; updatedAt: number } | undefined;
		return row
			? { enabled: true, enabledAt: row.enabledAt, updatedAt: row.updatedAt }
			: { enabled: false, enabledAt: null, updatedAt: null };
	}

	async isEnabled(accountId: string): Promise<boolean> {
		return (await this.get(accountId)).enabled;
	}

	async countEnabled(): Promise<number> {
		await this.db.ready;
		const result = await this.db.ops.execute(
			'SELECT COUNT(*) AS enabledAccounts FROM account_mcp_access'
		);
		return Number((result.rows[0] as unknown as { enabledAccounts: number }).enabledAccounts);
	}

	async enable(accountId: string, now = Date.now()): Promise<McpAccountAccess> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: `INSERT INTO account_mcp_access(account_id, enabled_at, updated_at)
				VALUES (?, ?, ?)
				ON CONFLICT(account_id) DO UPDATE SET updated_at = excluded.updated_at`,
			args: [accountId, now, now]
		});
		return this.get(accountId);
	}

	async disable(accountId: string): Promise<McpAccountAccess> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM account_mcp_access WHERE account_id = ?',
			args: [accountId]
		});
		return this.get(accountId);
	}
}

let singleton: McpAccessStore | undefined;

export function getMcpAccessStore(): McpAccessStore {
	singleton ??= new McpAccessStore();
	return singleton;
}

export function closeMcpAccessStore(): void {
	singleton = undefined;
}
