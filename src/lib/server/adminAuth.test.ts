import { describe, expect, it } from 'vitest';
import { isAdminAuthorized, timingSafeStringEqual, unauthorizedAdminResponse } from './adminAuth';

describe('admin auth', () => {
	it('accepts only the exact bearer token', () => {
		const request = new Request('https://example.test/api/admin/status', {
			headers: { authorization: 'Bearer secret-token' }
		});
		expect(isAdminAuthorized(request, 'secret-token')).toBe(true);
		expect(isAdminAuthorized(request, 'other-token')).toBe(false);
		expect(isAdminAuthorized(request, '')).toBe(false);
	});

	it('rejects missing or malformed authorization headers', () => {
		expect(isAdminAuthorized(new Request('https://example.test'), 'secret-token')).toBe(false);
		expect(
			isAdminAuthorized(
				new Request('https://example.test', { headers: { authorization: 'secret-token' } }),
				'secret-token'
			)
		).toBe(false);
	});

	it('compares tokens in constant time without leaking length mismatches', () => {
		expect(timingSafeStringEqual('abc', 'abc')).toBe(true);
		expect(timingSafeStringEqual('abc', 'abd')).toBe(false);
		expect(timingSafeStringEqual('abc', 'ab')).toBe(false);
		expect(timingSafeStringEqual('', 'token')).toBe(false);
	});

	it('hides admin endpoints as 404', async () => {
		const response = unauthorizedAdminResponse();
		expect(response.status).toBe(404);
		await expect(response.text()).resolves.toBe('Not found\n');
	});
});
