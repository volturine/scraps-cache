import { describe, expect, it } from 'vitest';
import {
	GROK_OAUTH_REDIRECT_URI,
	OAUTH_BROWSER_ORIGINS,
	OAUTH_CLIENTS,
	isOAuthBrowserOrigin,
	isOAuthClientRedirect,
	oauthClientById,
	oauthClientForRedirect
} from './oauth';

describe('OAuth callback boundaries', () => {
	it('accepts every registered callback and no others', () => {
		expect(oauthClientForRedirect(GROK_OAUTH_REDIRECT_URI)).toBe('grok');
		expect(oauthClientForRedirect('https://claude.ai/api/mcp/auth_callback')).toBe('claude');
		expect(
			oauthClientForRedirect('https://www.perplexity.com/rest/connections/oauth_callback')
		).toBe('perplexity');
		expect(oauthClientForRedirect('https://chatgpt.com/connector/oauth/id')).toBe('chatgpt');
		expect(oauthClientForRedirect('http://127.0.0.1:27890/callback')).toBe('hermes');
		expect(oauthClientById('hermes')?.applicationType).toBe('native');
		expect(OAUTH_BROWSER_ORIGINS).toEqual(['https://grok.com']);
		expect(isOAuthBrowserOrigin('https://grok.com')).toBe(true);
		expect(isOAuthBrowserOrigin('https://chatgpt.com')).toBe(false);
		expect(isOAuthBrowserOrigin('https://claude.ai')).toBe(false);
		expect(OAUTH_CLIENTS.map((client) => client.id)).toEqual([
			'grok',
			'claude',
			'perplexity',
			'chatgpt',
			'hermes'
		]);
	});

	it.each([
		'https://claude.ai.evil.example/api/mcp/auth_callback',
		'https://claude.ai/api/mcp/auth_callback?redirect=elsewhere',
		'https://www.perplexity.ai.evil.example/rest/connections/oauth_callback',
		'https://www.perplexity.com.evil.example/rest/connections/oauth_callback',
		'https://www.perplexity.com@evil.example/rest/connections/oauth_callback',
		'http://www.perplexity.com/rest/connections/oauth_callback',
		'https://www.perplexity.com/rest/connections/oauth_callback?redirect=elsewhere',
		'https://www.perplexity.com/rest/connections/oauth_callback#fragment',
		'https://www.perplexity.com/other',
		'https://enterprise.perplexity.com.evil.example/rest/connections/oauth_callback',
		'https://enterprise.perplexity.com@evil.example/rest/connections/oauth_callback',
		'http://enterprise.perplexity.com/rest/connections/oauth_callback',
		'https://enterprise.perplexity.com/rest/connections/oauth_callback?redirect=elsewhere',
		'https://enterprise.perplexity.com/rest/connections/oauth_callback#fragment',
		'https://enterprise.perplexity.com/other',
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
		expect(
			isOAuthClientRedirect('grok', 'https://www.perplexity.com/rest/connections/oauth_callback')
		).toBe(false);
	});
});
