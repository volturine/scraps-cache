import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getManagedAccount: vi.fn(),
	setAccountByteQuota: vi.fn(),
	clearAccountByteQuota: vi.fn()
}));

vi.mock('$lib/server/adminAccounts', () => ({ getManagedAccount: mocks.getManagedAccount }));
vi.mock('$lib/server/cloudflareAccess', () => ({
	authenticateCloudflareAdmin: async () => 'owner@example.com'
}));
vi.mock('$lib/server/syncStore', () => ({
	getSyncStore: () => ({
		setAccountByteQuota: mocks.setAccountByteQuota,
		clearAccountByteQuota: mocks.clearAccountByteQuota
	})
}));

import { DELETE, POST, PUT } from './+server';

const accountId = 'account-123456789';
const managed = {
	usage: {
		envelopeCount: 2,
		ciphertextBytes: 100,
		storageBytes: 1_124,
		maxBytes: 5_000_000,
		overridden: true
	},
	mcp: { enabled: false, enabledAt: null, updatedAt: null }
};

type Handler = (event: {
	request: Request;
	getClientAddress(): string;
}) => Response | Promise<Response>;

function invoke(method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<Response> {
	const handler = { POST, PUT, DELETE }[method] as unknown as Handler;
	return Promise.resolve(
		handler({
			request: new Request('https://scrapscache.com/admin/api/account', {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			getClientAddress: () => '127.0.0.1'
		})
	);
}

describe('admin console account route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getManagedAccount.mockResolvedValue(managed);
		mocks.setAccountByteQuota.mockResolvedValue(true);
		mocks.clearAccountByteQuota.mockResolvedValue(true);
	});

	it('returns account usage and both managed features', async () => {
		const response = await invoke('POST', { accountId });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual(managed);
	});

	it('sets and resets the storage limit', async () => {
		expect((await invoke('PUT', { accountId, maxBytes: 42_000_000 })).status).toBe(200);
		expect(mocks.setAccountByteQuota).toHaveBeenCalledWith(accountId, 42_000_000);
		expect((await invoke('DELETE', { accountId })).status).toBe(200);
		expect(mocks.clearAccountByteQuota).toHaveBeenCalledWith(accountId);
	});

	it('rejects invalid limits before updating storage', async () => {
		for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect((await invoke('PUT', { accountId, maxBytes })).status).toBe(400);
		}
		expect(mocks.setAccountByteQuota).not.toHaveBeenCalled();
	});
});
