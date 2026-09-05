import { describe, expect, it } from 'vitest';
import { isOAuthClientRedirect, oauthClientForRedirect } from './oauth';

describe('OAuth callback boundaries', () => {
	it.each([
		'https://chatgpt.com.evil.example/connector/oauth/id',
		'https://chatgpt.com@evil.example/connector/oauth/id',
		'http://chatgpt.com/connector/oauth/id',
		'https://chatgpt.com/connector/oauth/id?redirect=https://evil.example',
		'https://chatgpt.com/connector/oauth/id#fragment',
		'https://chatgpt.com/connector/oauth/../elsewhere',
		'https://chatgpt.com/connector/oauth/%2felsewhere',
		'https://chatgpt.com/connector/oauth/',
		'https://chatgpt.com/elsewhere',
		null
	])('rejects unapproved callback %s', (uri) => {
		expect(oauthClientForRedirect(uri)).toBeNull();
	});
	it('does not permit cross-provider client substitution', () => {
		expect(isOAuthClientRedirect('grok', 'https://chatgpt.com/connector/oauth/id')).toBe(false);
		expect(isOAuthClientRedirect(null, 'https://evil.example')).toBe(false);
	});
});
