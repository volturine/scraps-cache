import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	enableAccountMcp: vi.fn(),
	disableAccountMcp: vi.fn()
}));

vi.mock('$lib/server/adminAccounts', () => ({
	enableAccountMcp: mocks.enableAccountMcp,
	disableAccountMcp: mocks.disableAccountMcp
}));
vi.mock('$lib/server/cloudflareAccess', () => ({
	authenticateCloudflareAdmin: async () => 'owner@example.com'
}));

import { DELETE, PUT } from './+server';

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

function invoke(method: 'PUT' | 'DELETE', body: unknown): Promise<Response> {
	const handler = { PUT, DELETE }[method] as unknown as Handler;
	return Promise.resolve(
		handler({
			request: new Request('https://scrapscache.com/admin/api/account-mcp', {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			getClientAddress: () => '127.0.0.1',
			platform: { env: {} }
		})
	);
}

describe('admin console account MCP route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.enableAccountMcp.mockResolvedValue(managed);
		mocks.disableAccountMcp.mockResolvedValue({
			...managed,
			mcp: { enabled: false, enabledAt: null, updatedAt: 11 }
		});
	});

	it('enables and disables hosted MCP for a selected account', async () => {
		const enabled = await invoke('PUT', { accountId });
		expect(enabled.status).toBe(200);
		expect(await enabled.json()).toEqual(managed);
		expect(mocks.enableAccountMcp).toHaveBeenCalledWith(accountId);

		const disabled = await invoke('DELETE', { accountId });
		expect(disabled.status).toBe(200);
		expect(await disabled.json()).toMatchObject({ mcp: { enabled: false } });
		expect(mocks.disableAccountMcp).toHaveBeenCalledWith(accountId, { env: {} });
	});

	it('rejects malformed and unknown accounts', async () => {
		expect((await invoke('PUT', { accountId: '../bad' })).status).toBe(400);
		mocks.enableAccountMcp.mockResolvedValueOnce(null);
		expect((await invoke('PUT', { accountId })).status).toBe(404);
	});
});
