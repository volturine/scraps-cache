import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	credential: vi.fn((): string | null => 'scrypt:v1:legacy'),
	replace: vi.fn(() => true),
	sameSecret: vi.fn(async () => true),
	verifySignature: vi.fn(() => true),
	rateLimit: vi.fn((): { allowed: boolean; retryAfterSeconds?: number } => ({ allowed: true }))
}));

vi.mock('$lib/server/syncStore', () => ({
	getSyncStore: () => ({
		getAuthCredential: mocks.credential,
		replaceAuthCredential: mocks.replace
	})
}));
vi.mock('$lib/server/syncAuth', () => ({
	createSyncSession: () => ({ accessToken: 'token', expiresAt: 123 }),
	isLegacySyncCredential: (value: string) => value.startsWith('scrypt:v1:'),
	sameLegacySyncSecret: mocks.sameSecret,
	verifySyncMigration: mocks.verifySignature
}));
vi.mock('$lib/server/rateLimit', () => ({
	clientAddress: () => '127.0.0.1',
	publicApiLimiter: { check: mocks.rateLimit },
	rateLimitResponse: () => new Response(null, { status: 429 })
}));

import { POST } from './+server';

const body = {
	accountId: 'account-123456789',
	authSecret: 'a'.repeat(43),
	authPublicKey: 'public-key',
	signature: 'signature'
};

async function post(): Promise<Response> {
	return (
		POST as unknown as (event: {
			request: Request;
			getClientAddress(): string;
		}) => Promise<Response>
	)({
		request: new Request('https://example.test/api/sync/auth/migrate', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	});
}

describe('sync authentication migration route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.credential.mockReturnValue('scrypt:v1:legacy');
		mocks.replace.mockReturnValue(true);
		mocks.sameSecret.mockResolvedValue(true);
		mocks.verifySignature.mockReturnValue(true);
		mocks.rateLimit.mockReturnValue({ allowed: true });
	});

	it('atomically replaces a verified legacy credential and issues a session', async () => {
		const response = await post();
		expect(response.status).toBe(200);
		expect(mocks.replace).toHaveBeenCalledWith(
			body.accountId,
			'scrypt:v1:legacy',
			body.authPublicKey
		);
		expect(await response.json()).toEqual({ accessToken: 'token', expiresAt: 123 });
		expect(mocks.rateLimit).toHaveBeenNthCalledWith(1, 'auth-migrate-ip:127.0.0.1', {
			capacity: 120,
			refillWindowMs: 60 * 60 * 1000
		});
		expect(mocks.rateLimit).toHaveBeenNthCalledWith(2, `auth-migrate-account:${body.accountId}`, {
			capacity: 5,
			refillWindowMs: 60 * 60 * 1000
		});
	});

	it('rate limits repeated migrations per account without exhausting the shared IP pool', async () => {
		mocks.rateLimit
			.mockReturnValueOnce({ allowed: true })
			.mockReturnValueOnce({ allowed: false, retryAfterSeconds: 60 });

		const response = await post();

		expect(response.status).toBe(429);
		expect(mocks.sameSecret).not.toHaveBeenCalled();
	});

	it('rejects replay after the credential has already migrated', async () => {
		mocks.credential.mockReturnValue(body.authPublicKey);
		const response = await post();
		expect(response.status).toBe(401);
		expect(mocks.replace).not.toHaveBeenCalled();
	});
});
