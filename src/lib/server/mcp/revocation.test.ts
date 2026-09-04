import { describe, expect, it, afterEach, vi } from 'vitest';
import { McpRevocationStore } from './revocation';
import { testDb, cleanupTestDbs } from '../testDb';

afterEach(() => {
	cleanupTestDbs();
});

describe('mcp revocation store', () => {
	it('marks account as revoked before a timestamp', async () => {
		const db = testDb();
		const store = new McpRevocationStore(db);

		const accountId = 'account-1';
		const tokenTime1 = 1000;
		const tokenTime2 = 3000;

		expect(await store.isRevoked(accountId, tokenTime1)).toBe(false);

		// Revoke at t = 2000
		await store.revoke(accountId, 2000);

		// Token created at t = 1000 is revoked
		expect(await store.isRevoked(accountId, tokenTime1)).toBe(true);

		// Token created at t = 3000 is still valid
		expect(await store.isRevoked(accountId, tokenTime2)).toBe(false);
		expect(await store.getRevokedBefore(accountId)).toBe(2000);
	});
});
