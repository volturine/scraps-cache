import {
	createMcpRefreshGrant,
	createMcpTokenGrant,
	hashMcpRefreshToken,
	hashMcpToken,
	isMcpRefreshToken,
	isMcpToken,
	MCP_REFRESH_TTL_MS,
	MCP_TOKEN_TTL_MS,
	resolveStoredMcpToken,
	unwrapMcpRefreshKey,
	unwrapMcpSyncKey,
	type ResolvedMcpToken,
	type StoredMcpToken
} from '$lib/mcp/token';
import { isMcpGrantClientId, MCP_MANUAL_CLIENT_ID, type McpGrantClientId } from '$lib/mcp/oauth';
import { identityFromSyncKey } from '$lib/syncPairing';
import { getDb, type Db } from '$lib/server/db';

export class McpAccessDisabledError extends Error {
	constructor() {
		super('MCP access is not enabled for this account');
		this.name = 'McpAccessDisabledError';
	}
}

export type McpTokenGrantSummary = {
	clientId: McpGrantClientId;
	createdAt: number;
	expiresAt: number;
	refreshExpiresAt: number;
};

export type IssuedMcpGrant = {
	createdAt: number;
	expiresAt: number;
	refreshToken: string;
	refreshExpiresAt: number;
	replacedTokenHashes: string[];
};

export class McpTokenStore {
	constructor(private readonly db: Db = getDb()) {}

	async issue(
		accountId: string,
		token: string,
		wrappedSyncKey: string,
		clientId: McpGrantClientId = MCP_MANUAL_CLIENT_ID,
		now = Date.now()
	): Promise<IssuedMcpGrant> {
		if (!isMcpToken(token) || wrappedSyncKey.length > 512 || !isMcpGrantClientId(clientId))
			throw new Error('Invalid MCP token grant');
		const syncKey = unwrapMcpSyncKey(token, wrappedSyncKey);
		if (identityFromSyncKey(syncKey).accountId !== accountId) {
			throw new Error('MCP token grant does not belong to the authenticated account');
		}
		const refresh = createMcpRefreshGrant(syncKey);
		if (refresh.wrappedRefreshKey.length > 512) throw new Error('Invalid MCP token grant');

		const createdAt = now;
		const expiresAt = now + MCP_TOKEN_TTL_MS;
		const refreshExpiresAt = now + MCP_REFRESH_TTL_MS;
		await this.db.ready;
		const results = await this.db.ops.batch(
			[
				{
					sql: 'DELETE FROM mcp_tokens WHERE account_id = ? AND client_id = ? RETURNING token_hash AS tokenHash',
					args: [accountId, clientId]
				},
				{
					sql: `INSERT INTO mcp_tokens(
						token_hash, account_id, client_id, wrapped_sync_key, created_at, expires_at,
						refresh_hash, refresh_wrapped_sync_key, refresh_expires_at
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
						WHERE EXISTS (SELECT 1 FROM account_mcp_access WHERE account_id = ?)`,
					args: [
						hashMcpToken(token),
						accountId,
						clientId,
						wrappedSyncKey,
						createdAt,
						expiresAt,
						hashMcpRefreshToken(refresh.refreshToken),
						refresh.wrappedRefreshKey,
						refreshExpiresAt,
						accountId
					]
				}
			],
			'write'
		);
		if (results.at(-1)?.rowsAffected !== 1) {
			throw new McpAccessDisabledError();
		}
		return {
			createdAt,
			expiresAt,
			refreshToken: refresh.refreshToken,
			refreshExpiresAt,
			replacedTokenHashes: results[0].rows.map((row) =>
				String((row as unknown as { tokenHash: string }).tokenHash)
			)
		};
	}

	async refresh(
		refreshToken: string,
		clientId: McpGrantClientId,
		now = Date.now()
	): Promise<
		(IssuedMcpGrant & { token: string; wrappedSyncKey: string; accountId: string }) | null
	> {
		if (!isMcpRefreshToken(refreshToken) || !isMcpGrantClientId(clientId)) return null;
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT account_id AS accountId, refresh_wrapped_sync_key AS wrappedRefreshKey
				FROM mcp_tokens
				WHERE refresh_hash = ? AND client_id = ? AND refresh_expires_at > ?
					AND EXISTS (
						SELECT 1 FROM account_mcp_access
						WHERE account_mcp_access.account_id = mcp_tokens.account_id
					)`,
			args: [hashMcpRefreshToken(refreshToken), clientId, now]
		});
		const row = result.rows[0] as unknown as
			{ accountId: string; wrappedRefreshKey: string } | undefined;
		if (!row) return null;
		let syncKey: string;
		try {
			syncKey = unwrapMcpRefreshKey(refreshToken, row.wrappedRefreshKey);
		} catch {
			return null;
		}
		if (identityFromSyncKey(syncKey).accountId !== row.accountId) return null;
		const next = createMcpTokenGrant(syncKey);
		const issued = await this.issue(row.accountId, next.token, next.wrappedSyncKey, clientId, now);
		return {
			...issued,
			token: next.token,
			wrappedSyncKey: next.wrappedSyncKey,
			accountId: row.accountId
		};
	}

	async resolve(token: string, now = Date.now()): Promise<ResolvedMcpToken | null> {
		if (!isMcpToken(token)) return null;
		const tokenHash = hashMcpToken(token);
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT token_hash AS tokenHash, account_id AS accountId,
				wrapped_sync_key AS wrappedSyncKey, created_at AS createdAt, expires_at AS expiresAt
				FROM mcp_tokens
				WHERE token_hash = ? AND expires_at > ?
					AND EXISTS (
						SELECT 1 FROM account_mcp_access
						WHERE account_mcp_access.account_id = mcp_tokens.account_id
					)`,
			args: [tokenHash, now]
		});
		const row = result.rows[0] as unknown as StoredMcpToken | undefined;
		return row ? resolveStoredMcpToken(token, row) : null;
	}

	async listGrants(accountId: string, now = Date.now()): Promise<McpTokenGrantSummary[]> {
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `SELECT client_id AS clientId, created_at AS createdAt,
				expires_at AS expiresAt, refresh_expires_at AS refreshExpiresAt
				FROM mcp_tokens
				WHERE account_id = ? AND (expires_at > ? OR refresh_expires_at > ?)
				ORDER BY created_at ASC`,
			args: [accountId, now, now]
		});
		return result.rows.flatMap((row) => {
			const clientId = String((row as unknown as { clientId: string }).clientId);
			if (!isMcpGrantClientId(clientId)) return [];
			return [
				{
					clientId,
					createdAt: Number((row as unknown as { createdAt: number }).createdAt),
					expiresAt: Number((row as unknown as { expiresAt: number }).expiresAt),
					refreshExpiresAt: Number(
						(row as unknown as { refreshExpiresAt: number }).refreshExpiresAt
					)
				}
			];
		});
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
