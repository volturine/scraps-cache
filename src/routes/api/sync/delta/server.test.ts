import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class QuotaError extends Error {}
	return {
		QuotaError,
		getCredentialHash: vi.fn((): string | null => 'credential-hash'),
		sync: vi.fn(),
		limitChecks: vi.fn<(key: string) => { allowed: true }>(() => ({ allowed: true }))
	};
});

vi.mock('$lib/server/syncStore', () => ({
	SyncQuotaExceededError: mocks.QuotaError,
	getSyncStore: () => ({
		getCredentialHash: mocks.getCredentialHash,
		sync: mocks.sync
	})
}));
vi.mock('$lib/server/syncAuth', () => ({ sameSyncSecret: () => true }));
vi.mock('$lib/server/rateLimit', () => ({
	clientAddress: () => '127.0.0.1',
	enterSyncRequest: () => vi.fn(),
	publicApiLimiter: { check: (key: string) => mocks.limitChecks(key) },
	rateLimitResponse: () => new Response(null, { status: 429 })
}));
vi.mock('$lib/server/metrics', () => ({
	recordSqliteError: vi.fn(),
	recordSyncBatch: vi.fn()
}));

import { POST } from './+server';

const credentials = {
	accountId: 'account-123456789',
	authSecret: 'a'.repeat(32)
};

const validEnvelope = {
	id: 'envelope-id',
	slot: 'a'.repeat(64),
	expectedId: null,
	ciphertext: 'opaque'
};

async function post(body: unknown): Promise<Response> {
	return (
		POST as unknown as (event: {
			request: Request;
			getClientAddress(): string;
		}) => Promise<Response>
	)({
		request: new Request('http://localhost/api/sync/delta', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		}),
		getClientAddress: () => '127.0.0.1'
	});
}

describe('sync delta route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.limitChecks.mockImplementation(() => ({ allowed: true }));
		mocks.getCredentialHash.mockReturnValue('credential-hash');
		mocks.sync.mockReturnValue({
			cursor: 2,
			envelopes: [],
			conflicts: [],
			hasMore: false,
			reset: false,
			writesAccepted: true,
			usage: { envelopeCount: 2, ciphertextBytes: 12, maxBytes: 100, maxEnvelopes: 10 }
		});
	});

	it('passes validated conditional writes and bounded cursors to the relay', async () => {
		const replacement = { ...validEnvelope, id: 'replacement', expectedId: 'current-id' };
		const response = await post({
			...credentials,
			cursor: -1,
			limit: 999,
			envelopes: [validEnvelope, replacement],
			deleteSlots: [{ id: 'deleted-id', slot: 'b'.repeat(64) }]
		});

		expect(response.status).toBe(200);
		expect(mocks.sync).toHaveBeenCalledWith(
			credentials.accountId,
			0,
			[validEnvelope, replacement],
			[{ id: 'deleted-id', slot: 'b'.repeat(64) }],
			50
		);
		expect(await response.json()).toMatchObject({ writesAccepted: true, conflicts: [] });
	});

	it.each([
		['missing', undefined],
		['wrong type', 3],
		['invalid characters', 'not valid'],
		['too long', 'x'.repeat(129)]
	])('rejects an expectedId that is %s', async (_label, expectedId) => {
		const envelope = { ...validEnvelope } as Record<string, unknown>;
		if (expectedId !== undefined) envelope.expectedId = expectedId;
		else delete envelope.expectedId;

		const response = await post({ ...credentials, envelopes: [envelope], deleteSlots: [] });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: 'Invalid encrypted envelope batch' });
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it('rejects batches above the public protocol boundary', async () => {
		const envelopes = Array.from({ length: 2_001 }, (_, index) => ({
			...validEnvelope,
			id: `envelope-${index}`
		}));
		const response = await post({ ...credentials, envelopes, deleteSlots: [] });

		expect(response.status).toBe(400);
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it.each([
		['empty id', { id: '', slot: 'b'.repeat(64) }],
		['non-hash slot', { id: 'deleted-id', slot: 'not-a-slot' }]
	])('rejects an invalid deletion with %s', async (_label, deletion) => {
		const response = await post({ ...credentials, envelopes: [], deleteSlots: [deletion] });

		expect(response.status).toBe(400);
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it('does not reveal whether an account exists when authentication fails', async () => {
		mocks.getCredentialHash.mockReturnValue(null);
		const response = await post({ ...credentials, envelopes: [], deleteSlots: [] });

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Invalid sync account credentials' });
	});

	it('consumes the per-account bucket only after credentials verify', async () => {
		mocks.getCredentialHash.mockReturnValue(null);
		await post({ ...credentials, envelopes: [], deleteSlots: [] });
		expect(mocks.limitChecks.mock.calls.map(([key]) => key)).toEqual(['sync-ip:127.0.0.1']);

		mocks.getCredentialHash.mockReturnValue('credential-hash');
		await post({ ...credentials, envelopes: [], deleteSlots: [] });
		expect(mocks.limitChecks.mock.calls.map(([key]) => key)).toEqual([
			'sync-ip:127.0.0.1',
			'sync-ip:127.0.0.1',
			'sync-account:account-123456789'
		]);
	});

	it('maps an atomic relay quota rejection to HTTP 507', async () => {
		mocks.sync.mockImplementation(() => {
			throw new mocks.QuotaError();
		});
		const response = await post({ ...credentials, envelopes: [], deleteSlots: [] });

		expect(response.status).toBe(507);
		expect(await response.json()).toEqual({ error: 'Sync account storage quota exceeded' });
	});
});
