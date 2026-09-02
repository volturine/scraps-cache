import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
	SyncAuth,
	validAuthPublicKey,
	verifySyncMigration,
	verifySyncRegistration
} from './syncAuth';
import {
	createSyncIdentity,
	legacyAuthSecret,
	signSyncChallenge,
	signSyncMigration,
	signSyncRegistration
} from '$lib/syncPairing';
import { testDb, cleanupTestDbs } from './testDb';
import type { Db } from './db';

afterEach(() => cleanupTestDbs());

describe('sync proof-of-possession sessions', () => {
	let db: Db;
	let syncAuth: SyncAuth;

	beforeEach(() => {
		db = testDb();
		syncAuth = new SyncAuth(db);
	});

	it('exchanges a valid signature for a 30-minute bearer session', async () => {
		const identity = createSyncIdentity();
		const challenge = await syncAuth.createSyncChallenge(identity.accountId);
		const issuedAt = Date.now();
		const session = await syncAuth.exchangeSyncChallenge(
			identity.accountId,
			identity.authPublicKey,
			challenge.challengeId,
			signSyncChallenge(identity.syncKey, identity.accountId, challenge.challenge)
		);
		expect(session?.expiresAt).toBeGreaterThanOrEqual(issuedAt + 30 * 60 * 1000);
		expect(session?.expiresAt).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
		expect(
			await syncAuth.authenticateSyncRequest(
				new Request('https://example.test', {
					headers: { authorization: `Bearer ${session?.accessToken}` }
				})
			)
		).toBe(identity.accountId);
	});

	it('consumes a challenge after one exchange attempt', async () => {
		const identity = createSyncIdentity();
		const challenge = await syncAuth.createSyncChallenge(identity.accountId);
		expect(
			await syncAuth.exchangeSyncChallenge(
				identity.accountId,
				identity.authPublicKey,
				challenge.challengeId,
				'x'
			)
		).toBeNull();
		expect(
			await syncAuth.exchangeSyncChallenge(
				identity.accountId,
				identity.authPublicKey,
				challenge.challengeId,
				signSyncChallenge(identity.syncKey, identity.accountId, challenge.challenge)
			)
		).toBeNull();
	});

	it('validates public keys and signed registration messages', () => {
		const identity = createSyncIdentity();
		expect(validAuthPublicKey(identity.authPublicKey)).toBe(true);
		expect(validAuthPublicKey('invalid')).toBe(false);
		expect(validAuthPublicKey(Buffer.alloc(32).toString('base64url'))).toBe(false);
		expect(
			verifySyncRegistration(
				identity.accountId,
				identity.authPublicKey,
				signSyncRegistration(identity.syncKey, identity.accountId, identity.authPublicKey)
			)
		).toBe(true);
		expect(
			verifySyncMigration(
				identity.accountId,
				identity.authPublicKey,
				signSyncMigration(identity.syncKey, identity.accountId, identity.authPublicKey)
			)
		).toBe(true);
	});
});
