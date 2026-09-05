import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpTokenGrant } from '$lib/mcp/token';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import type { Db } from '$lib/server/db';
import { SyncStore } from '$lib/server/syncStore';
import { McpAccessStore, closeMcpAccessStore } from '$lib/server/mcp/accessStore';
import { McpTokenStore, closeMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { closeMcpOAuthStore } from '$lib/server/mcp/oauthStore';

let mockDb: Db;

vi.mock('$lib/server/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db')>();
	return { ...actual, getDb: () => mockDb };
});

vi.mock('$lib/server/syncStore', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/syncStore')>();
	return { ...actual, getSyncStore: () => new actual.SyncStore(mockDb) };
});

import { disableAccountMcp, enableAccountMcp, getManagedAccount } from './adminAccounts';

afterEach(() => {
	closeMcpAccessStore();
	closeMcpTokenStore();
	closeMcpOAuthStore();
	cleanupTestDbs();
});

describe('admin account management', () => {
	it('reports usage, enables MCP, and revokes credentials when disabled', async () => {
		mockDb = testDb();
		const identity = createSyncIdentity();
		await new SyncStore(mockDb).createAccount(identity.accountId, 'credential');

		await expect(getManagedAccount(identity.accountId)).resolves.toMatchObject({
			usage: { storageBytes: 0, maxBytes: 100_000_000, overridden: false },
			mcp: { enabled: false }
		});
		await expect(enableAccountMcp(identity.accountId)).resolves.toMatchObject({
			mcp: { enabled: true }
		});

		const grant = createMcpTokenGrant(identity.syncKey);
		const tokenStore = new McpTokenStore(mockDb);
		await tokenStore.issue(identity.accountId, grant.token, grant.wrappedSyncKey);
		await expect(tokenStore.resolve(grant.token)).resolves.not.toBeNull();

		await expect(disableAccountMcp(identity.accountId, undefined)).resolves.toMatchObject({
			mcp: { enabled: false }
		});
		await expect(tokenStore.resolve(grant.token)).resolves.toBeNull();
		expect((await new McpAccessStore(mockDb).get(identity.accountId)).enabled).toBe(false);
	});

	it('does not create entitlements for unknown accounts', async () => {
		mockDb = testDb();
		await expect(enableAccountMcp('account-123456789')).resolves.toBeNull();
	});
});
