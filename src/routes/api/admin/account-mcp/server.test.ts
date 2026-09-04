import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	authorized: true,
	getManagedAccount: vi.fn(),
	enableAccountMcp: vi.fn(),
	disableAccountMcp: vi.fn()
}));

vi.mock('$lib/server/adminAuth', () => ({
	isAdminAuthorized: () => mocks.authorized,
	unauthorizedAdminResponse: () => new Response('Not found\n', { status: 404 })
}));
vi.mock('$lib/server/rateLimit', () => ({
	checkAdminApiLimit: async () => ({ allowed: true }),
	rateLimitResponse: () => new Response(null, { status: 429 })
}));
vi.mock('$lib/server/adminAccounts', () => ({
	getManagedAccount: mocks.getManagedAccount,
	enableAccountMcp: mocks.enableAccountMcp,
	disableAccountMcp: mocks.disableAccountMcp
}));

import { DELETE, POST, PUT } from './+server';

const accountId = 'account-123456789';
const managed = {
	usage: { storageBytes: 0 },
	mcp: { enabled: true, enabledAt: 10, updatedAt: 10 }
};

type Handler = (event: {
	request: Request;
	getClientAddress(): string;
	platform?: unknown;
}) => Response | Promise<Response>;

function invoke(method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<Response> {
	const handler = { POST, PUT, DELETE }[method] as unknown as Handler;
	return Promise.resolve(
		handler({
			request: new Request('https://scrapscache.com/api/admin/account-mcp', {
				method,
				headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			getClientAddress: () => '127.0.0.1',
			platform: { env: {} }
		})
	);
}

describe('admin account MCP route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authorized = true;
		mocks.getManagedAccount.mockResolvedValue(managed);
		mocks.enableAccountMcp.mockResolvedValue(managed);
		mocks.disableAccountMcp.mockResolvedValue({ ...managed, mcp: { enabled: false } });
	});

	it('does not inspect account input without an admin token', async () => {
		mocks.authorized = false;
		expect((await invoke('POST', { accountId })).status).toBe(404);
		expect(mocks.getManagedAccount).not.toHaveBeenCalled();
	});

	it('reads, enables, and disables the premium entitlement', async () => {
		expect(await (await invoke('POST', { accountId })).json()).toMatchObject({ enabled: true });
		expect((await invoke('PUT', { accountId })).status).toBe(200);
		expect(mocks.enableAccountMcp).toHaveBeenCalledWith(accountId);

		const disabled = await invoke('DELETE', { accountId });
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({ enabled: false });
		expect(mocks.disableAccountMcp).toHaveBeenCalledWith(accountId, { env: {} });
	});

	it('rejects malformed and unknown accounts', async () => {
		expect((await invoke('PUT', { accountId: '../bad' })).status).toBe(400);
		mocks.enableAccountMcp.mockResolvedValueOnce(null);
		expect((await invoke('PUT', { accountId })).status).toBe(404);
	});
});
