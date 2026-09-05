import { describe, expect, it } from 'vitest';
import {
	OAUTH_TOKEN_PATH,
	stampOriginlessOAuthToken,
	withOriginlessOAuthTokenStamp
} from './oauthCsrf';

const origin = 'https://scrapscache.com';

function request(
	pathname: string,
	init: { origin?: string | null; contentType?: string; method?: string } = {}
): Request {
	const headers = new Headers();
	if (init.origin) headers.set('origin', init.origin);
	if (init.contentType) headers.set('content-type', init.contentType);
	return new Request(new URL(pathname, origin), {
		method: init.method ?? 'POST',
		headers,
		body: init.method === 'GET' ? undefined : 'code=value'
	});
}

describe('stampOriginlessOAuthToken', () => {
	it('stamps the request origin onto originless form POSTs to the token route', () => {
		const stamped = stampOriginlessOAuthToken(
			request(OAUTH_TOKEN_PATH, { contentType: 'application/x-www-form-urlencoded' })
		);
		expect(stamped.headers.get('origin')).toBe(origin);
	});

	it('leaves every other request unchanged', () => {
		const grok = request(OAUTH_TOKEN_PATH, {
			origin: 'https://grok.com',
			contentType: 'application/x-www-form-urlencoded'
		});
		expect(stampOriginlessOAuthToken(grok)).toBe(grok);

		const register = request('/api/sync/register', {
			contentType: 'application/x-www-form-urlencoded'
		});
		expect(stampOriginlessOAuthToken(register)).toBe(register);
		expect(register.headers.get('origin')).toBeNull();

		const json = request(OAUTH_TOKEN_PATH, { contentType: 'application/json' });
		expect(stampOriginlessOAuthToken(json)).toBe(json);

		const get = request(OAUTH_TOKEN_PATH, { method: 'GET' });
		expect(stampOriginlessOAuthToken(get)).toBe(get);
	});

	it('stamps the Node adapter handler immediately before SvelteKit CSRF', async () => {
		const handler = await import('node:fs/promises').then((fs) =>
			fs.readFile('node_modules/@sveltejs/adapter-node/files/handler.js', 'utf8')
		);
		const injected = withOriginlessOAuthTokenStamp(handler);
		expect(
			injected.startsWith("import { stampOriginlessOAuthToken } from './oauthCsrf.ts';\n")
		).toBe(true);
		expect(injected).toContain(
			'request = stampOriginlessOAuthToken(request);\n\tconst response = await server.respond(request,'
		);
		expect(withOriginlessOAuthTokenStamp(injected)).toBe(injected);
		expect(() => withOriginlessOAuthTokenStamp('export const handler = () => {};')).toThrow(
			/cannot skip CSRF on the OAuth token route/
		);
	});
});
