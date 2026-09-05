import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '$lib/server/db';
import { GROK_OAUTH_REDIRECT_URI, MCP_OAUTH_CLIENT_ID, pkceChallenge } from '$lib/mcp/oauth';
import {
	createMcpTokenGrant,
	isMcpRefreshToken,
	isMcpToken,
	MCP_TOKEN_TTL_MS
} from '$lib/mcp/token';
import { closeMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { closeMcpTokenStore, McpTokenStore } from '$lib/server/mcp/tokenStore';
import { closePublicApiLimiter } from '$lib/server/rateLimit';
import { closeSyncAuth, getSyncAuth } from '$lib/server/syncAuth';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import { createSyncIdentity } from '$lib/syncPairing';
import { McpAccessStore, closeMcpAccessStore } from '$lib/server/mcp/accessStore';

let mockDb: Db;

vi.mock('$lib/server/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db')>();
	return {
		...actual,
		getDb: () => mockDb
	};
});

import {
	authorizationServerMetadata,
	protectedResourceMetadata
} from '$lib/server/mcp/oauthMetadata';
import { POST as authorizeHandler } from './authorize/+server';
import { POST as registerHandler } from './register/+server';
import { OPTIONS as tokenOptionsHandler, POST as tokenHandler } from './token/+server';

describe('MCP OAuth routes', () => {
	beforeEach(() => {
		mockDb = testDb();
	});

	afterEach(() => {
		closeMcpOAuthStore();
		closeMcpTokenStore();
		closeMcpAccessStore();
		closePublicApiLimiter();
		closeSyncAuth();
		cleanupTestDbs();
	});

	it.each([
		[MCP_OAUTH_CLIENT_ID, GROK_OAUTH_REDIRECT_URI],
		['chatgpt', 'https://chatgpt.com/connector_platform_oauth_redirect'],
		['chatgpt', 'https://chatgpt.com/connector/oauth/test-callback-id'],
		['claude', 'https://claude.ai/api/mcp/auth_callback'],
		['perplexity', 'https://www.perplexity.ai/rest/connections/oauth_callback'],
		['perplexity', 'https://www.perplexity.com/rest/connections/oauth_callback'],
		['perplexity', 'https://enterprise.perplexity.ai/rest/connections/oauth_callback'],
		['perplexity', 'https://enterprise.perplexity.com/rest/connections/oauth_callback'],
		['perplexity', 'https://staging.perplexity.ai/rest/connections/oauth_callback'],
		['perplexity', 'https://staging.perplexity.com/rest/connections/oauth_callback'],
		['hermes', 'http://127.0.0.1:27890/callback'],
		['hermes', 'http://localhost:54321/callback']
	])('exchanges a browser-approved PKCE code for %s at %s', async (clientId, redirectUri) => {
		const registrationRequest = new Request('https://scrapscache.com/api/mcp/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' })
		});
		const registration = await (registerHandler as any)({
			request: registrationRequest,
			getClientAddress: () => '127.0.0.1'
		});
		expect(registration.status).toBe(201);
		expect(await registration.json()).toMatchObject({
			client_id: clientId,
			redirect_uris: [redirectUri]
		});
		const identity = createSyncIdentity();
		await new McpAccessStore(mockDb).enable(identity.accountId);
		const existingGrant = createMcpTokenGrant(identity.syncKey);
		const tokenStore = new McpTokenStore(mockDb);
		await tokenStore.issue(identity.accountId, existingGrant.token, existingGrant.wrappedSyncKey);
		const syncSession = await getSyncAuth().createSyncSession(identity.accountId);
		const codeGrant = createMcpTokenGrant(identity.syncKey);
		const verifier = 'v'.repeat(43);
		const authorizeRequest = new Request('https://scrapscache.com/api/mcp/oauth/authorize', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${syncSession.accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				responseType: 'code',
				clientId,
				redirectUri,
				scope: 'mcp',
				state: 'opaque-state',
				codeChallenge: pkceChallenge(verifier),
				codeChallengeMethod: 'S256',
				resource: 'https://scrapscache.com/api/mcp',
				code: codeGrant.token,
				wrappedSyncKey: codeGrant.wrappedSyncKey
			})
		});
		const authorizeResponse = await (authorizeHandler as any)({
			request: authorizeRequest,
			url: new URL(authorizeRequest.url),
			getClientAddress: () => '127.0.0.1'
		});
		expect(authorizeResponse.status).toBe(200);
		expect(authorizeResponse.headers.get('cache-control')).toBe('no-store');
		const redirect = new URL((await authorizeResponse.json()).redirectTo);
		expect(`${redirect.origin}${redirect.pathname}`).toBe(redirectUri);
		expect(redirect.searchParams.get('code')).toBe(codeGrant.token);
		expect(redirect.searchParams.get('state')).toBe('opaque-state');
		expect(redirect.searchParams.get('iss')).toBe('https://scrapscache.com');

		const storedCode = await mockDb.ops.execute('SELECT * FROM mcp_oauth_codes');
		expect(JSON.stringify(storedCode.rows)).not.toContain(codeGrant.token);
		expect(JSON.stringify(storedCode.rows)).not.toContain(identity.syncKey);

		const form = new URLSearchParams({
			grant_type: 'authorization_code',
			code: codeGrant.token,
			client_id: clientId,
			redirect_uri: redirectUri,
			code_verifier: verifier,
			resource: 'https://scrapscache.com/api/mcp'
		});
		const tokenRequest = new Request('https://scrapscache.com/api/mcp/oauth/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: form
		});
		const tokenResponse = await (tokenHandler as any)({
			request: tokenRequest,
			url: new URL(tokenRequest.url),
			platform: undefined,
			getClientAddress: () => '127.0.0.1'
		});
		expect(tokenResponse.status).toBe(200);
		expect(tokenResponse.headers.get('access-control-allow-origin')).toBeNull();
		const token = await tokenResponse.json();
		expect(token).toMatchObject({
			token_type: 'Bearer',
			scope: 'mcp',
			expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000)
		});
		expect(isMcpToken(token.access_token)).toBe(true);
		expect(isMcpRefreshToken(token.refresh_token)).toBe(true);
		await expect(tokenStore.resolve(token.access_token)).resolves.toMatchObject({
			accountId: identity.accountId,
			syncKey: identity.syncKey
		});
		await expect(tokenStore.resolve(existingGrant.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});

		const refreshed = await (tokenHandler as any)({
			request: new Request(tokenRequest.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					refresh_token: token.refresh_token,
					client_id: clientId,
					resource: 'https://scrapscache.com/api/mcp'
				})
			}),
			url: new URL(tokenRequest.url),
			platform: undefined,
			getClientAddress: () => '127.0.0.1'
		});
		expect(refreshed.status).toBe(200);
		const next = await refreshed.json();
		expect(isMcpToken(next.access_token)).toBe(true);
		expect(next.access_token).not.toBe(token.access_token);
		expect(isMcpRefreshToken(next.refresh_token)).toBe(true);
		await expect(tokenStore.resolve(token.access_token)).resolves.toBeNull();
		await expect(tokenStore.resolve(next.access_token)).resolves.toMatchObject({
			accountId: identity.accountId,
			syncKey: identity.syncKey
		});
		await expect(tokenStore.resolve(existingGrant.token)).resolves.toMatchObject({
			accountId: identity.accountId
		});

		const replayResponse = await (tokenHandler as any)({
			request: new Request(tokenRequest.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: form
			}),
			url: new URL(tokenRequest.url),
			platform: undefined,
			getClientAddress: () => '127.0.0.1'
		});
		expect(replayResponse.status).toBe(400);
		expect(await replayResponse.json()).toMatchObject({ error: 'invalid_grant' });
	});

	it('publishes OAuth and MCP protected-resource discovery metadata', async () => {
		const authorizationResponse = authorizationServerMetadata('https://scrapscache.com');
		expect(authorizationResponse.headers.get('cache-control')).toBe('no-store');
		const authorization = await authorizationResponse.json();
		expect(authorization).toMatchObject({
			issuer: 'https://scrapscache.com',
			authorization_endpoint: 'https://scrapscache.com/mcp/oauth/authorize',
			token_endpoint: 'https://scrapscache.com/api/mcp/oauth/token',
			registration_endpoint: 'https://scrapscache.com/api/mcp/oauth/register',
			code_challenge_methods_supported: ['S256'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			token_endpoint_auth_methods_supported: ['none'],
			authorization_response_iss_parameter_supported: true
		});
		const resourceResponse = protectedResourceMetadata('https://scrapscache.com');
		expect(resourceResponse.headers.get('cache-control')).toBe('no-store');
		const resource = await resourceResponse.json();
		expect(resource).toMatchObject({
			resource: 'https://scrapscache.com/api/mcp',
			authorization_servers: ['https://scrapscache.com'],
			bearer_methods_supported: ['header']
		});
	});

	it('allows Grok to read browser token-exchange responses', async () => {
		const response = await (tokenOptionsHandler as any)({
			request: new Request('https://scrapscache.com/api/mcp/oauth/token', {
				method: 'OPTIONS',
				headers: { Origin: 'https://grok.com' }
			})
		});
		expect(response.status).toBe(204);
		expect(response.headers.get('access-control-allow-origin')).toBe('https://grok.com');
		expect(response.headers.get('access-control-allow-methods')).toBe('POST');
	});

	it('registers only the Grok public client and exact callback', async () => {
		const registrationRequest = new Request('https://scrapscache.com/api/mcp/oauth/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				client_name: 'Grok',
				redirect_uris: [GROK_OAUTH_REDIRECT_URI],
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code'],
				scope: 'mcp offline_access',
				application_type: 'native'
			})
		});
		const registrationResponse = await (registerHandler as any)({
			request: registrationRequest,
			getClientAddress: () => '127.0.0.1'
		});
		expect(registrationResponse.status).toBe(201);
		expect(registrationResponse.headers.get('cache-control')).toBe('no-store');
		const registeredClient = await registrationResponse.json();
		expect(registeredClient).toMatchObject({
			client_id: MCP_OAUTH_CLIENT_ID,
			redirect_uris: [GROK_OAUTH_REDIRECT_URI],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: 'mcp',
			application_type: 'web'
		});
		expect(registeredClient).not.toHaveProperty('client_secret');

		const confidentialClientRequest = new Request(registrationRequest.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				redirect_uris: [GROK_OAUTH_REDIRECT_URI],
				token_endpoint_auth_method: 'client_secret_post'
			})
		});
		const confidentialClientResponse = await (registerHandler as any)({
			request: confidentialClientRequest,
			getClientAddress: () => '127.0.0.1'
		});
		expect(confidentialClientResponse.status).toBe(400);
		expect(await confidentialClientResponse.json()).toMatchObject({
			error: 'invalid_client_metadata'
		});

		const maliciousRequest = new Request(registrationRequest.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				redirect_uris: ['https://attacker.example/callback'],
				token_endpoint_auth_method: 'none'
			})
		});
		const maliciousResponse = await (registerHandler as any)({
			request: maliciousRequest,
			getClientAddress: () => '127.0.0.1'
		});
		expect(maliciousResponse.status).toBe(400);
		expect(await maliciousResponse.json()).toMatchObject({ error: 'invalid_redirect_uri' });
	});

	it('registers all four standard and Enterprise Perplexity callbacks together', async () => {
		const redirects = [
			'https://www.perplexity.ai/rest/connections/oauth_callback',
			'https://www.perplexity.com/rest/connections/oauth_callback',
			'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
			'https://enterprise.perplexity.com/rest/connections/oauth_callback'
		];
		const response = await (registerHandler as any)({
			request: new Request('https://scrapscache.com/api/mcp/oauth/register', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ redirect_uris: redirects, token_endpoint_auth_method: 'none' })
			}),
			getClientAddress: () => '127.0.0.1'
		});
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({
			client_id: 'perplexity',
			redirect_uris: redirects,
			token_endpoint_auth_method: 'none'
		});
	});

	it.each([
		[[], 'redirect_uris must be a non-empty array'],
		[[123], 'Unsupported redirect_uris[0]: not a URL string'],
		[['not-a-url'], 'Unsupported redirect_uris[0]: invalid URL'],
		[['data:text/plain,private-value'], 'Unsupported redirect_uris[0]: unsupported URL scheme'],
		[
			[
				GROK_OAUTH_REDIRECT_URI,
				'https://user:password@unsupported.example/callback?token=secret#private'
			],
			'Unsupported redirect_uris[1]: https://unsupported.example/callback (query present) (fragment present)'
		],
		[
			[GROK_OAUTH_REDIRECT_URI, 'https://claude.ai/api/mcp/auth_callback'],
			'Use supported callbacks belonging to one OAuth client'
		]
	])(
		'explains rejected callbacks without reflecting credentials: %j',
		async (redirects, description) => {
			const response = await (registerHandler as any)({
				request: new Request('https://scrapscache.com/api/mcp/oauth/register', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ redirect_uris: redirects })
				}),
				getClientAddress: () => '127.0.0.1'
			});
			expect(response.status).toBe(400);
			expect(response.headers.get('cache-control')).toBe('no-store');
			expect(await response.json()).toEqual({
				error: 'invalid_redirect_uri',
				error_description: description
			});
		}
	);

	it('rejects redirect substitution before storing an authorization code', async () => {
		const identity = createSyncIdentity();
		await new McpAccessStore(mockDb).enable(identity.accountId);
		const syncSession = await getSyncAuth().createSyncSession(identity.accountId);
		const codeGrant = createMcpTokenGrant(identity.syncKey);
		const request = new Request('https://scrapscache.com/api/mcp/oauth/authorize', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${syncSession.accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				responseType: 'code',
				clientId: MCP_OAUTH_CLIENT_ID,
				redirectUri: 'https://attacker.example/callback',
				scope: 'mcp',
				codeChallenge: pkceChallenge('x'.repeat(43)),
				codeChallengeMethod: 'S256',
				code: codeGrant.token,
				wrappedSyncKey: codeGrant.wrappedSyncKey
			})
		});
		const response = await (authorizeHandler as any)({
			request,
			url: new URL(request.url),
			getClientAddress: () => '127.0.0.1'
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: 'invalid_request' });
		await mockDb.ready;
		expect((await mockDb.ops.execute('SELECT * FROM mcp_oauth_codes')).rows).toHaveLength(0);
	});
});
