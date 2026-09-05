import { describe, expect, it } from 'vitest';
import { isOAuthClientRedirect, oauthClientForRedirect } from './oauth';

describe('OAuth callback boundaries', () => {
	it.each([
		'https://claude.ai.evil.example/api/mcp/auth_callback',
		'https://claude.ai/api/mcp/auth_callback?redirect=elsewhere',
		'https://www.perplexity.ai.evil.example/rest/connections/oauth_callback',
		'https://perplexity.ai/rest/connections/oauth_callback',
		'http://localhost.evil.example:27890/callback',
		'http://127.0.0.2:27890/callback',
		'http://192.168.1.1:27890/callback',
		'http://localhost:0/callback',
		'http://localhost:65536/callback',
		'http://localhost:27890/callback?redirect=elsewhere',
		'http://localhost:27890/callback#fragment',
		'http://localhost:27890/other',
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
