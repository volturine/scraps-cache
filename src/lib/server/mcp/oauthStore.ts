import {
	isOAuthClientRedirect,
	MCP_OAUTH_CODE_TTL_MS,
	isPkceChallenge,
	isPkceVerifier,
	pkceChallenge
} from '$lib/mcp/oauth';
import { hashMcpToken, isMcpToken, unwrapMcpSyncKey, type McpTokenGrant } from '$lib/mcp/token';
import { identityFromSyncKey } from '$lib/syncPairing';
import { getDb, type Db } from '$lib/server/db';

export type McpOAuthCodeRequest = Pick<McpTokenGrant, 'token' | 'wrappedSyncKey'> & {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	resource: string;
};

export type McpOAuthCodeExchange = {
	code: string;
	clientId: string;
	redirectUri: string;
	codeVerifier: string;
	resource: string;
};

type StoredCode = {
	accountId: string;
	wrappedSyncKey: string;
};

export class McpOAuthStore {
	constructor(private readonly db: Db = getDb()) {}

	async createCode(
		accountId: string,
		request: McpOAuthCodeRequest,
		now = Date.now()
	): Promise<number> {
		if (
			!isOAuthClientRedirect(request.clientId, request.redirectUri) ||
			!isPkceChallenge(request.codeChallenge) ||
			!isMcpToken(request.token) ||
			request.wrappedSyncKey.length > 512
		) {
			throw new Error('Invalid OAuth authorization request');
		}
		const syncKey = unwrapMcpSyncKey(request.token, request.wrappedSyncKey);
		if (identityFromSyncKey(syncKey).accountId !== accountId) {
			throw new Error('OAuth grant does not belong to the authenticated account');
		}

		const expiresAt = now + MCP_OAUTH_CODE_TTL_MS;
		await this.db.ready;
		const results = await this.db.ops.batch(
			[
				{ sql: 'DELETE FROM mcp_oauth_codes WHERE expires_at <= ?', args: [now] },
				{
					sql: `INSERT INTO mcp_oauth_codes(
						code_hash, account_id, wrapped_sync_key, client_id,
						redirect_uri, code_challenge, resource, expires_at
					) SELECT ?, ?, ?, ?, ?, ?, ?, ?
					WHERE EXISTS (SELECT 1 FROM account_mcp_access WHERE account_id = ?)`,
					args: [
						hashMcpToken(request.token),
						accountId,
						request.wrappedSyncKey,
						request.clientId,
						request.redirectUri,
						request.codeChallenge,
						request.resource,
						expiresAt,
						accountId
					]
				}
			],
			'write'
		);
		if (results.at(-1)?.rowsAffected !== 1) {
			throw new Error('MCP access is not enabled for this account');
		}
		return expiresAt;
	}

	async consumeCode(
		request: McpOAuthCodeExchange,
		now = Date.now()
	): Promise<{ accountId: string; syncKey: string } | null> {
		if (
			!isOAuthClientRedirect(request.clientId, request.redirectUri) ||
			!isMcpToken(request.code) ||
			!isPkceVerifier(request.codeVerifier)
		) {
			return null;
		}
		const challenge = pkceChallenge(request.codeVerifier);
		await this.db.ready;
		const result = await this.db.ops.execute({
			sql: `DELETE FROM mcp_oauth_codes
				WHERE code_hash = ? AND client_id = ? AND redirect_uri = ?
					AND code_challenge = ? AND resource = ? AND expires_at > ?
					AND EXISTS (
						SELECT 1 FROM account_mcp_access
						WHERE account_mcp_access.account_id = mcp_oauth_codes.account_id
					)
				RETURNING account_id AS accountId, wrapped_sync_key AS wrappedSyncKey`,
			args: [
				hashMcpToken(request.code),
				request.clientId,
				request.redirectUri,
				challenge,
				request.resource,
				now
			]
		});
		const row = result.rows[0] as unknown as StoredCode | undefined;
		if (!row) return null;
		try {
			const syncKey = unwrapMcpSyncKey(request.code, row.wrappedSyncKey);
			if (identityFromSyncKey(syncKey).accountId !== row.accountId) return null;
			return { accountId: row.accountId, syncKey };
		} catch {
			return null;
		}
	}

	async revokeAccountCodes(accountId: string): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM mcp_oauth_codes WHERE account_id = ?',
			args: [accountId]
		});
	}

	async pruneExpired(now = Date.now()): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM mcp_oauth_codes WHERE expires_at <= ?',
			args: [now]
		});
	}
}

let singleton: McpOAuthStore | undefined;

export function getMcpOAuthStore(): McpOAuthStore {
	singleton ??= new McpOAuthStore();
	return singleton;
}

export function closeMcpOAuthStore(): void {
	singleton = undefined;
}
