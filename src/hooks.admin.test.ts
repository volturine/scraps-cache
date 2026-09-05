import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), bearer: vi.fn(), record: vi.fn() }));

vi.mock('$lib/server/cloudflareAccess', () => ({
	authenticateCloudflareAdmin: mocks.authenticate
}));
vi.mock('$lib/server/adminAuth', () => ({
	isAdminAuthorized: mocks.bearer
}));
vi.mock('$lib/server/metrics', () => ({ recordHttpRequest: mocks.record }));

import { handle } from './hooks.server';

function event(path: string, headers?: HeadersInit) {
	const url = new URL(path, 'https://scrapscache.com');
	return {
		request: new Request(url, { headers }),
		url
	};
}

describe('admin route protection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.bearer.mockReturnValue(false);
	});

	it('hides the operator page when the Cloudflare Access assertion is not accepted', async () => {
		mocks.authenticate.mockResolvedValue(null);
		const resolve = vi.fn(async () => new Response('private console'));
		const response = await (handle as any)({ event: event('/admin'), resolve });
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('resolves an admin page only after Cloudflare Access authentication', async () => {
		mocks.authenticate.mockResolvedValue('owner@example.com');
		const resolve = vi.fn(async () => new Response('private console'));
		const response = await (handle as any)({ event: event('/admin'), resolve });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('private console');
		expect(resolve).toHaveBeenCalledOnce();
	});

	it('allows the admin API with an Access assertion or the operator bearer token', async () => {
		mocks.authenticate.mockResolvedValue(null);
		const resolve = vi.fn(async () => new Response('ok'));
		expect(
			(
				await (handle as any)({
					event: event('/admin/api/status'),
					resolve
				})
			).status
		).toBe(404);
		expect(resolve).not.toHaveBeenCalled();

		mocks.bearer.mockReturnValue(true);
		const bearer = await (handle as any)({
			event: event('/admin/api/status', { Authorization: 'Bearer secret' }),
			resolve
		});
		expect(bearer.status).toBe(200);
		expect(resolve).toHaveBeenCalledOnce();
	});
});
