import { afterEach, describe, expect, it } from 'vitest';
import { createMcpTokenGrant, MCP_TOKEN_TTL_MS } from '$lib/mcp/token';
import { createSyncIdentity } from '$lib/syncPairing';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import { McpTokenStore } from './tokenStore';
import { McpAccessStore } from './accessStore';

afterEach(cleanupTestDbs);

describe('McpTokenStore', () => {
	it('resolves an issued token and rejects it after revocation', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		await new McpAccessStore(db).enable(identity.accountId);
		await store.issue(identity.accountId, grant.token, grant.wrappedSyncKey);
		const stored = await db.ops.execute('SELECT * FROM mcp_tokens');
		expect(JSON.stringify(stored.rows)).not.toContain(grant.token);
		expect(JSON.stringify(stored.rows)).not.toContain(identity.syncKey);

		await expect(store.resolve(grant.token)).resolves.toMatchObject({
			accountId: identity.accountId,
			syncKey: identity.syncKey
		});
		await expect(store.revokeAccount(identity.accountId)).resolves.toEqual([
			expect.stringMatching(/^[0-9a-f]{64}$/)
		]);
		await expect(store.resolve(grant.token)).resolves.toBeNull();
	});

	it('rejects a grant for a different authenticated account', async () => {
		const store = new McpTokenStore(testDb());
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		await expect(
			store.issue('different-account', grant.token, grant.wrappedSyncKey)
		).rejects.toThrow('does not belong');
	});

	it('rotates only the same client grant', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const manual = createMcpTokenGrant(identity.syncKey);
		const grok = createMcpTokenGrant(identity.syncKey);
		const grokReplacement = createMcpTokenGrant(identity.syncKey);
		await store.issue(identity.accountId, manual.token, manual.wrappedSyncKey);
		await store.issue(identity.accountId, grok.token, grok.wrappedSyncKey, 'grok');
		await store.issue(
			identity.accountId,
			grokReplacement.token,
			grokReplacement.wrappedSyncKey,
			'grok'
		);
		await expect(store.resolve(manual.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});
		await expect(store.resolve(grok.token)).resolves.toBeNull();
		await expect(store.resolve(grokReplacement.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});
		await expect(store.listGrants(identity.accountId)).resolves.toEqual([
			expect.objectContaining({ clientId: 'manual' }),
			expect.objectContaining({ clientId: 'grok' })
		]);
	});

	it('stops resolving expired tokens', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const grant = createMcpTokenGrant(identity.syncKey);
		const issued = await store.issue(
			identity.accountId,
			grant.token,
			grant.wrappedSyncKey,
			'manual',
			1_000
		);
		expect(issued.expiresAt).toBe(1_000 + MCP_TOKEN_TTL_MS);
		await expect(store.resolve(grant.token, 1_000 + MCP_TOKEN_TTL_MS)).resolves.toBeNull();
		await expect(store.listGrants(identity.accountId, 1_000 + MCP_TOKEN_TTL_MS)).resolves.toEqual([
			expect.objectContaining({ clientId: 'manual' })
		]);
	});

	it('issues a new access token from a still-valid refresh grant after access expiry', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const grant = createMcpTokenGrant(identity.syncKey);
		const issued = await store.issue(
			identity.accountId,
			grant.token,
			grant.wrappedSyncKey,
			'grok',
			1_000
		);
		await expect(store.resolve(grant.token, 1_000 + MCP_TOKEN_TTL_MS)).resolves.toBeNull();
		const rotated = await store.refresh(issued.refreshToken, 'grok', 1_000 + MCP_TOKEN_TTL_MS);
		expect(rotated?.token).not.toBe(grant.token);
		await expect(store.resolve(rotated!.token, 1_000 + MCP_TOKEN_TTL_MS)).resolves.toMatchObject({
			accountId: identity.accountId,
			syncKey: identity.syncKey
		});
		await expect(
			store.refresh(issued.refreshToken, 'grok', 1_000 + MCP_TOKEN_TTL_MS)
		).resolves.toBeNull();
	});

	it('rejects issuance by default and stops resolving tokens after access is disabled', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const access = new McpAccessStore(db);
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);

		await expect(
			store.issue(identity.accountId, grant.token, grant.wrappedSyncKey)
		).rejects.toThrow('not enabled');
		await access.enable(identity.accountId);
		await store.issue(identity.accountId, grant.token, grant.wrappedSyncKey);
		await access.disable(identity.accountId);
		await expect(store.resolve(grant.token)).resolves.toBeNull();
	});
});
