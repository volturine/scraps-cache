import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), record: vi.fn() }));

vi.mock('$lib/server/cloudflareAccess', () => ({
	authenticateCloudflareAdmin: mocks.authenticate
}));
vi.mock('$lib/server/metrics', () => ({ recordHttpRequest: mocks.record }));

import { handle } from './hooks.server';

function event(path: string) {
	const url = new URL(path, 'https://scrapscache.com');
	return {
		request: new Request(url),
		url
	};
}

describe('admin route protection', () => {
	beforeEach(() => vi.clearAllMocks());

	it('hides every admin path when the Cloudflare Access assertion is not accepted', async () => {
		mocks.authenticate.mockResolvedValue(null);
		const resolve = vi.fn(async () => new Response('private console'));
		const response = await (handle as any)({ event: event('/admin/api/status'), resolve });
		expect(response.status).toBe(404);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(resolve).not.toHaveBeenCalled();
	});

	it('resolves an admin request only after Cloudflare Access authentication', async () => {
		mocks.authenticate.mockResolvedValue('owner@example.com');
		const resolve = vi.fn(async () => new Response('private console'));
		const response = await (handle as any)({ event: event('/admin'), resolve });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('private console');
		expect(resolve).toHaveBeenCalledOnce();
	});
});
