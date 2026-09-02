import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountId = 'account-123456789';
const mocks = vi.hoisted(() => ({
	authorized: true,
	getAccountByteQuota: vi.fn(),
	setAccountByteQuota: vi.fn(),
	clearAccountByteQuota: vi.fn()
}));

vi.mock('$lib/server/adminAuth', () => ({
	isAdminAuthorized: () => mocks.authorized,
	unauthorizedAdminResponse: () => new Response('Not found\n', { status: 404 })
}));
vi.mock('$lib/server/rateLimit', () => ({
	checkAdminApiLimit: async () => ({ allowed: true }),
	rateLimitResponse: () => new Response(null, { status: 429 })
}));
vi.mock('$lib/server/syncStore', () => ({
	getSyncStore: () => ({
		getAccountByteQuota: mocks.getAccountByteQuota,
		setAccountByteQuota: mocks.setAccountByteQuota,
		clearAccountByteQuota: mocks.clearAccountByteQuota
	})
}));

import { DELETE, POST, PUT } from './+server';

type Handler = (event: {
	request: Request;
	getClientAddress(): string;
}) => Response | Promise<Response>;

function request(method: string, body: unknown): Promise<Response> {
	const handler = { POST, PUT, DELETE }[method] as unknown as Handler;
	return Promise.resolve(
		handler({
			request: new Request('https://example.test/api/admin/account-quota', {
				method,
				headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}),
			getClientAddress: () => '127.0.0.1'
		})
	);
}

describe('admin account quota route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authorized = true;
		mocks.getAccountByteQuota.mockReturnValue({ maxBytes: 1024 ** 3, overridden: true });
		mocks.setAccountByteQuota.mockReturnValue(true);
		mocks.clearAccountByteQuota.mockReturnValue(true);
	});

	it('requires the admin bearer token before reading the account ID', async () => {
		mocks.authorized = false;
		const response = await request('POST', { accountId: 'invalid' });
		expect(response.status).toBe(404);
		expect(mocks.getAccountByteQuota).not.toHaveBeenCalled();
	});

	it('sets and returns a per-account byte quota', async () => {
		const response = await request('PUT', { accountId, maxBytes: 2 * 1024 ** 3 });
		expect(response.status).toBe(200);
		expect(mocks.setAccountByteQuota).toHaveBeenCalledWith(accountId, 2 * 1024 ** 3);
		expect(await response.json()).toEqual({ maxBytes: 1024 ** 3, overridden: true });
	});

	it('returns the effective quota without caching account data', async () => {
		const response = await request('POST', { accountId });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(mocks.getAccountByteQuota).toHaveBeenCalledWith(accountId);
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid maxBytes %s',
		async (maxBytes) => {
			const response = await request('PUT', { accountId, maxBytes });
			expect(response.status).toBe(400);
			expect(mocks.setAccountByteQuota).not.toHaveBeenCalled();
		}
	);

	it('clears an override and returns the effective default', async () => {
		mocks.getAccountByteQuota.mockReturnValue({ maxBytes: 1024 ** 3, overridden: false });
		const response = await request('DELETE', { accountId });
		expect(response.status).toBe(200);
		expect(mocks.clearAccountByteQuota).toHaveBeenCalledWith(accountId);
		expect(await response.json()).toEqual({ maxBytes: 1024 ** 3, overridden: false });
	});

	it('returns 404 for a missing account', async () => {
		mocks.setAccountByteQuota.mockReturnValue(false);
		expect((await request('PUT', { accountId, maxBytes: 10 })).status).toBe(404);
	});
});
