import {
	hashMcpToken,
	isMcpToken,
	resolveStoredMcpToken,
	unwrapMcpSyncKey,
	type ResolvedMcpToken,
	type StoredMcpToken
} from '$lib/mcp/token';
import { identityFromSyncKey } from '$lib/syncPairing';
import { getDb, type Db } from '$lib/server/db';

export class McpTokenStore {
	constructor(private readonly db: Db = getDb()) {}

	async issue(
		accountId: string,
		token: string,
		wrappedSyncKey: string,
		rotateExisting = true
	): Promise<{ createdAt: number; replacedTokenHashes: string[] }> {
		if (!isMcpToken(token) || wrappedSyncKey.length > 512)
			throw new Error('Invalid MCP token grant');
		const syncKey = unwrapMcpSyncKey(token, wrappedSyncKey);
		if (identityFromSyncKey(syncKey).accountId !== accountId) {
			throw new Error('MCP token grant does not belong to the authenticated account');
		}

		const createdAt = Date.now();
		await this.db.ready;
		const statements = [
			...(rotateExisting
				? [
						{
							sql: 'DELETE FROM mcp_tokens WHERE account_id = ? RETURNING token_hash AS tokenHash',
							args: [accountId]
						}
					]
				: []),
			{
				sql: `INSERT INTO mcp_tokens(token_hash, account_id, wrapped_sync_key, created_at)
						VALUES (?, ?, ?, ?)`,
				args: [hashMcpToken(token), accountId, wrappedSyncKey, createdAt]
			}
		];
		const results = await this.db.ops.batch(statements, 'write');
		return {
			createdAt,
			replacedTokenHashes: rotateExisting
				? results[0].rows.map((row) => String((row as unknown as { tokenHash: string }).tokenHash))
				: []
		};
	}

	async resolve(token: string): Promise<ResolvedMcpToken | null> {
		if (!isMcpToken(token)) return null;
		const tokenHash = hashMcpToken(token);
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT token_hash AS tokenHash, account_id AS accountId,
				wrapped_sync_key AS wrappedSyncKey, created_at AS createdAt
				FROM mcp_tokens WHERE token_hash = ?`,
			args: [tokenHash]
		});
		const row = result.rows[0] as unknown as StoredMcpToken | undefined;
		return row ? resolveStoredMcpToken(token, row) : null;
	}

	async revokeAccount(accountId: string): Promise<string[]> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: 'SELECT token_hash AS tokenHash FROM mcp_tokens WHERE account_id = ?',
			args: [accountId]
		});
		await this.db.ops.execute({
			sql: 'DELETE FROM mcp_tokens WHERE account_id = ?',
			args: [accountId]
		});
		return result.rows.map((row) => String((row as unknown as { tokenHash: string }).tokenHash));
	}
}

let singleton: McpTokenStore | undefined;

export function getMcpTokenStore(): McpTokenStore {
	singleton ??= new McpTokenStore();
	return singleton;
}

export function closeMcpTokenStore(): void {
	singleton = undefined;
}
