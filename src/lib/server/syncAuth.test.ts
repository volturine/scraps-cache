import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	authenticateSyncRequest,
	createSyncChallenge,
	exchangeSyncChallenge,
	legacySyncSecretHash,
	resetSyncAuthForTests,
	sameLegacySyncSecret,
	SESSION_TTL_MS,
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

describe('sync proof-of-possession sessions', () => {
	beforeEach(() => resetSyncAuthForTests());

	it('exchanges a valid signature for a 30-minute bearer session', () => {
		const identity = createSyncIdentity();
		const challenge = createSyncChallenge(identity.accountId);
		const issuedAt = Date.now();
		const session = exchangeSyncChallenge(
			identity.accountId,
			identity.authPublicKey,
			challenge.challengeId,
			signSyncChallenge(identity.syncKey, identity.accountId, challenge.challenge)
		);
		expect(session?.expiresAt).toBeGreaterThanOrEqual(issuedAt + SESSION_TTL_MS);
		expect(session?.expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);
		expect(
			authenticateSyncRequest(
				new Request('https://example.test', {
					headers: { authorization: `Bearer ${session?.accessToken}` }
				})
			)
		).toBe(identity.accountId);
	});

	it('consumes a challenge after one exchange attempt', () => {
		const identity = createSyncIdentity();
		const challenge = createSyncChallenge(identity.accountId);
		expect(
			exchangeSyncChallenge(identity.accountId, identity.authPublicKey, challenge.challengeId, 'x')
		).toBeNull();
		expect(
			exchangeSyncChallenge(
				identity.accountId,
				identity.authPublicKey,
				challenge.challengeId,
				signSyncChallenge(identity.syncKey, identity.accountId, challenge.challenge)
			)
		).toBeNull();
	});

	it('expires bearer sessions', () => {
		vi.useFakeTimers();
		try {
			const identity = createSyncIdentity();
			const challenge = createSyncChallenge(identity.accountId);
			const session = exchangeSyncChallenge(
				identity.accountId,
				identity.authPublicKey,
				challenge.challengeId,
				signSyncChallenge(identity.syncKey, identity.accountId, challenge.challenge)
			)!;
			vi.advanceTimersByTime(SESSION_TTL_MS);
			expect(
				authenticateSyncRequest(
					new Request('https://example.test', {
						headers: { authorization: `Bearer ${session.accessToken}` }
					})
				)
			).toBeNull();
		} finally {
			vi.useRealTimers();
		}
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

	it('verifies the legacy credential used for a one-time migration', async () => {
		const identity = createSyncIdentity();
		const secret = legacyAuthSecret(identity.syncKey);
		const hash = await legacySyncSecretHash(secret);
		await expect(sameLegacySyncSecret(hash, secret)).resolves.toBe(true);
		await expect(sameLegacySyncSecret(hash, 'wrong-secret')).resolves.toBe(false);
	});
});
