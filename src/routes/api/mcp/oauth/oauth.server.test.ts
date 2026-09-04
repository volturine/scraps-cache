import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '$lib/server/db';
import { GROK_OAUTH_REDIRECT_URI, MCP_OAUTH_CLIENT_ID, pkceChallenge } from '$lib/mcp/oauth';
import { createMcpTokenGrant, isMcpToken } from '$lib/mcp/token';
import { closeMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { closeMcpTokenStore, McpTokenStore } from '$lib/server/mcp/tokenStore';
import { closePublicApiLimiter } from '$lib/server/rateLimit';
import { closeSyncAuth, getSyncAuth } from '$lib/server/syncAuth';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import { createSyncIdentity } from '$lib/syncPairing';

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
import { POST as tokenHandler } from './token/+server';

describe('MCP OAuth routes', () => {
	beforeEach(() => {
		mockDb = testDb();
	});

	afterEach(() => {
		closeMcpOAuthStore();
		closeMcpTokenStore();
		closePublicApiLimiter();
		closeSyncAuth();
		cleanupTestDbs();
	});

	it('exchanges one browser-approved PKCE code without persisting plaintext secrets', async () => {
		const identity = createSyncIdentity();
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
				clientId: MCP_OAUTH_CLIENT_ID,
				redirectUri: GROK_OAUTH_REDIRECT_URI,
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
		expect(`${redirect.origin}${redirect.pathname}`).toBe(GROK_OAUTH_REDIRECT_URI);
		expect(redirect.searchParams.get('code')).toBe(codeGrant.token);
		expect(redirect.searchParams.get('state')).toBe('opaque-state');
		expect(redirect.searchParams.get('iss')).toBe('https://scrapscache.com');

		const storedCode = await mockDb.ops.execute('SELECT * FROM mcp_oauth_codes');
		expect(JSON.stringify(storedCode.rows)).not.toContain(codeGrant.token);
		expect(JSON.stringify(storedCode.rows)).not.toContain(identity.syncKey);

		const form = new URLSearchParams({
			grant_type: 'authorization_code',
			code: codeGrant.token,
			client_id: MCP_OAUTH_CLIENT_ID,
			redirect_uri: GROK_OAUTH_REDIRECT_URI,
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
		const token = await tokenResponse.json();
		expect(token).toMatchObject({ token_type: 'Bearer', scope: 'mcp' });
		expect(isMcpToken(token.access_token)).toBe(true);
		await expect(tokenStore.resolve(token.access_token)).resolves.toMatchObject({
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
		const authorization = await authorizationServerMetadata('https://scrapscache.com').json();
		expect(authorization).toMatchObject({
			issuer: 'https://scrapscache.com',
			authorization_endpoint: 'https://scrapscache.com/mcp/oauth/authorize',
			token_endpoint: 'https://scrapscache.com/api/mcp/oauth/token',
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none'],
			authorization_response_iss_parameter_supported: true
		});
		const resource = await protectedResourceMetadata('https://scrapscache.com').json();
		expect(resource).toMatchObject({
			resource: 'https://scrapscache.com/api/mcp',
			authorization_servers: ['https://scrapscache.com'],
			bearer_methods_supported: ['header']
		});
	});

	it('rejects redirect substitution before storing an authorization code', async () => {
		const identity = createSyncIdentity();
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
