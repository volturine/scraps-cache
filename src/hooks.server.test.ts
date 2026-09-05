import { describe, expect, it } from 'vitest';
import { rejectsCrossSiteForm } from './hooks.server';

const url = new URL('https://scrapscache.com/api/mcp/oauth/token');

function formRequest(origin?: string, pathname = url.pathname): Request {
	const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded' });
	if (origin) headers.set('Origin', origin);
	return new Request(new URL(pathname, url), { method: 'POST', headers, body: 'code=value' });
}

describe('cross-site form protection', () => {
	it('allows registered browser OAuth clients and originless token exchange', () => {
		expect(rejectsCrossSiteForm(formRequest('https://grok.com'), url)).toBe(false);
		expect(rejectsCrossSiteForm(formRequest(), url)).toBe(false);
		expect(rejectsCrossSiteForm(formRequest('https://chatgpt.com'), url)).toBe(true);
		expect(rejectsCrossSiteForm(formRequest('https://claude.ai'), url)).toBe(true);
		expect(
			rejectsCrossSiteForm(
				formRequest(undefined, '/api/sync/register'),
				new URL('https://scrapscache.com/api/sync/register')
			)
		).toBe(true);
		expect(
			rejectsCrossSiteForm(
				formRequest('https://grok.com', '/api/sync/register'),
				new URL('https://scrapscache.com/api/sync/register')
			)
		).toBe(true);
	});

	it('still rejects every other cross-site form origin', () => {
		expect(rejectsCrossSiteForm(formRequest('https://attacker.example'), url)).toBe(true);
	});
});
