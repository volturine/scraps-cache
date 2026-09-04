import { afterEach, describe, expect, it } from 'vitest';
import { createMcpTokenGrant } from '$lib/mcp/token';
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

	it('rotates the previous account token', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const first = createMcpTokenGrant(identity.syncKey);
		const second = createMcpTokenGrant(identity.syncKey);
		await store.issue(identity.accountId, first.token, first.wrappedSyncKey);
		await store.issue(identity.accountId, second.token, second.wrappedSyncKey);
		await expect(store.resolve(first.token)).resolves.toBeNull();
		await expect(store.resolve(second.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});
	});

	it('can issue an additional client token without invalidating existing clients', async () => {
		const db = testDb();
		const store = new McpTokenStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const first = createMcpTokenGrant(identity.syncKey);
		const second = createMcpTokenGrant(identity.syncKey);
		await store.issue(identity.accountId, first.token, first.wrappedSyncKey);
		await expect(
			store.issue(identity.accountId, second.token, second.wrappedSyncKey, false)
		).resolves.toMatchObject({ replacedTokenHashes: [] });
		await expect(store.resolve(first.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});
		await expect(store.resolve(second.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});
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
