import { afterEach, describe, expect, it } from 'vitest';
import { GROK_OAUTH_REDIRECT_URI, MCP_OAUTH_CLIENT_ID, pkceChallenge } from '$lib/mcp/oauth';
import { createMcpTokenGrant } from '$lib/mcp/token';
import { createSyncIdentity } from '$lib/syncPairing';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import { McpOAuthStore } from './oauthStore';
import { McpAccessStore } from './accessStore';

afterEach(cleanupTestDbs);

describe('McpOAuthStore', () => {
	it.each([
		[
			'chatgpt',
			'https://chatgpt.com/connector/oauth/first',
			'https://chatgpt.com/connector/oauth/second'
		],
		['hermes', 'http://127.0.0.1:27890/callback', 'http://127.0.0.1:27891/callback']
	])('binds %s codes to the exact callback', async (clientId, redirectUri, otherRedirectUri) => {
		const db = testDb();
		const store = new McpOAuthStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const grant = createMcpTokenGrant(identity.syncKey);
		const verifier = 'a'.repeat(43);
		const resource = 'https://scrapscache.com/api/mcp';
		await store.createCode(identity.accountId, {
			...grant,
			clientId,
			redirectUri,
			resource,
			codeChallenge: pkceChallenge(verifier)
		});
		const exchange = {
			code: grant.token,
			clientId,
			redirectUri,
			resource,
			codeVerifier: verifier
		};
		await expect(
			store.consumeCode({ ...exchange, redirectUri: otherRedirectUri })
		).resolves.toBeNull();
		await expect(store.consumeCode(exchange)).resolves.toMatchObject({
			accountId: identity.accountId
		});
		await expect(store.consumeCode(exchange)).resolves.toBeNull();
	});
	it('stores only a hashed code and consumes it once with the matching PKCE verifier', async () => {
		const db = testDb();
		const store = new McpOAuthStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const grant = createMcpTokenGrant(identity.syncKey);
		const verifier = 'a'.repeat(43);
		const resource = 'https://scrapscache.com/api/mcp';
		const request = {
			token: grant.token,
			wrappedSyncKey: grant.wrappedSyncKey,
			clientId: MCP_OAUTH_CLIENT_ID,
			redirectUri: GROK_OAUTH_REDIRECT_URI,
			codeChallenge: pkceChallenge(verifier),
			resource
		};

		await store.createCode(identity.accountId, request, 1_000);
		const stored = await db.ops.execute('SELECT * FROM mcp_oauth_codes');
		expect(JSON.stringify(stored.rows)).not.toContain(grant.token);
		expect(JSON.stringify(stored.rows)).not.toContain(identity.syncKey);

		await expect(
			store.consumeCode(
				{
					code: grant.token,
					clientId: MCP_OAUTH_CLIENT_ID,
					redirectUri: GROK_OAUTH_REDIRECT_URI,
					codeVerifier: 'b'.repeat(43),
					resource
				},
				2_000
			)
		).resolves.toBeNull();

		const exchange = {
			code: grant.token,
			clientId: MCP_OAUTH_CLIENT_ID,
			redirectUri: GROK_OAUTH_REDIRECT_URI,
			codeVerifier: verifier,
			resource
		};
		await expect(store.consumeCode(exchange, 2_000)).resolves.toEqual({
			accountId: identity.accountId,
			syncKey: identity.syncKey
		});
		await expect(store.consumeCode(exchange, 2_000)).resolves.toBeNull();
	});

	it('rejects expired codes without exposing the sync key', async () => {
		const db = testDb();
		const store = new McpOAuthStore(db);
		const identity = createSyncIdentity();
		await new McpAccessStore(db).enable(identity.accountId);
		const grant = createMcpTokenGrant(identity.syncKey);
		const verifier = 'c'.repeat(43);
		const resource = 'https://scrapscache.com/api/mcp';
		await store.createCode(
			identity.accountId,
			{
				token: grant.token,
				wrappedSyncKey: grant.wrappedSyncKey,
				clientId: MCP_OAUTH_CLIENT_ID,
				redirectUri: GROK_OAUTH_REDIRECT_URI,
				codeChallenge: pkceChallenge(verifier),
				resource
			},
			1_000
		);
		await expect(
			store.consumeCode(
				{
					code: grant.token,
					clientId: MCP_OAUTH_CLIENT_ID,
					redirectUri: GROK_OAUTH_REDIRECT_URI,
					codeVerifier: verifier,
					resource
				},
				1_000 + 5 * 60 * 1_000
			)
		).resolves.toBeNull();
	});
});
