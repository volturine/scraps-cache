import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTestDbs, testDb } from '$lib/server/testDb';
import type { Db } from '$lib/server/db';
import { closeMcpSessionManager } from '$lib/server/mcp/sessionManager';
import { closeMcpTokenStore, McpTokenStore } from '$lib/server/mcp/tokenStore';
import { closeSyncAuth, getSyncAuth } from '$lib/server/syncAuth';
import { closePublicApiLimiter } from '$lib/server/rateLimit';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpTokenGrant, hashMcpToken } from '$lib/mcp/token';

let mockDb: Db;

vi.mock('$lib/server/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db')>();
	return {
		...actual,
		getDb: () => mockDb
	};
});

import { GET as sseHandler } from './sse/+server';
import { POST as messagesHandler } from './messages/+server';
import { POST as revokeHandler } from './revoke/+server';
import { POST as tokenHandler } from './token/+server';

describe('mcp api routes', () => {
	let identity: ReturnType<typeof createSyncIdentity>;
	let token: string;

	beforeEach(async () => {
		mockDb = testDb();
		identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		token = grant.token;
		await new McpTokenStore(mockDb).issue(identity.accountId, grant.token, grant.wrappedSyncKey);
	});

	afterEach(() => {
		closeMcpSessionManager();
		closeMcpTokenStore();
		closeSyncAuth();
		closePublicApiLimiter();
		cleanupTestDbs();
	});

	it('uses the same bearer token automatically across SSE and message requests', async () => {
		const sseRequest = new Request('http://localhost:5173/api/mcp/sse', {
			headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }
		});
		const sseResponse = await (sseHandler as any)({
			request: sseRequest,
			url: new URL(sseRequest.url),
			platform: undefined
		});
		expect(sseResponse.status).toBe(200);
		const reader = sseResponse.body.getReader();
		const firstChunk = new TextDecoder().decode((await reader.read()).value);
		expect(firstChunk).toContain('data: http://localhost:5173/api/mcp/messages');
		expect(firstChunk).not.toContain('token=');

		const legacyRequest = new Request('http://localhost:5173/api/mcp/messages', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
		});
		const legacyResponse = await (messagesHandler as any)({
			request: legacyRequest,
			url: new URL(legacyRequest.url),
			platform: undefined
		});
		expect(legacyResponse.status).toBe(202);
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('"id":1');

		const initRequest = new Request('http://localhost:5173/api/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${token}`
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'initialize',
				params: { protocolVersion: 'made-up-version' }
			})
		});
		const initResponse = await (messagesHandler as any)({
			request: initRequest,
			url: new URL(initRequest.url),
			platform: undefined
		});
		expect(initResponse.status).toBe(200);
		expect(initResponse.headers.get('mcp-session-id')).toBeNull();
		expect((await initResponse.json()).result.protocolVersion).toBe('2024-11-05');
		await reader.cancel();
	});

	it('rejects query credentials and session identifiers without bearer authorization', async () => {
		for (const url of [
			`http://localhost:5173/api/mcp/sse?token=${token}`,
			'http://localhost:5173/api/mcp/messages?sessionId=known-account.attacker-value'
		]) {
			const request = new Request(url, url.includes('messages') ? { method: 'POST' } : undefined);
			const handler = url.includes('messages') ? messagesHandler : sseHandler;
			const response = await (handler as any)({
				request,
				url: new URL(url),
				platform: undefined
			});
			expect(response.status).toBe(401);
		}
	});

	it('routes Cloudflare sessions by token hash and rejects foreign browser origins', async () => {
		const idFromName = vi.fn((name: string) => name);
		const fetch = vi.fn(async () => new Response(null, { status: 204 }));
		const request = new Request('https://scrapscache.com/api/mcp', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
			body: '{}'
		});
		const response = await (messagesHandler as any)({
			request,
			url: new URL(request.url),
			getClientAddress: () => '127.0.0.1',
			platform: { env: { ACCOUNT_MCP_SESSION: { idFromName, get: () => ({ fetch }) } } }
		});
		expect(response.status).toBe(204);
		expect(idFromName).toHaveBeenCalledWith(hashMcpToken(token));
		expect(idFromName).not.toHaveBeenCalledWith(identity.accountId);

		const foreignOrigin = new Request('https://scrapscache.com/api/mcp', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, Origin: 'https://attacker.example' },
			body: '{}'
		});
		expect(
			(
				await (messagesHandler as any)({
					request: foreignOrigin,
					url: new URL(foreignOrigin.url),
					getClientAddress: () => '127.0.0.1',
					platform: undefined
				})
			).status
		).toBe(403);
	});

	it('issues and revokes MCP access using sync authentication', async () => {
		const syncSession = await getSyncAuth().createSyncSession(identity.accountId);
		const replacement = createMcpTokenGrant(identity.syncKey);
		const issueRequest = new Request('http://localhost:5173/api/mcp/token', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${syncSession.accessToken}`
			},
			body: JSON.stringify({
				token: replacement.token,
				wrappedSyncKey: replacement.wrappedSyncKey
			})
		});
		expect(await (tokenHandler as any)({ request: issueRequest })).toMatchObject({ status: 200 });

		const revokeRequest = new Request('http://localhost:5173/api/mcp/revoke', {
			method: 'POST',
			headers: { Authorization: `Bearer ${syncSession.accessToken}` }
		});
		const revokeResponse = await (revokeHandler as any)({
			request: revokeRequest,
			platform: undefined
		});
		expect(revokeResponse.status).toBe(200);

		const mcpRequest = new Request('http://localhost:5173/api/mcp', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				Authorization: `Bearer ${replacement.token}`
			},
			body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })
		});
		const rejected = await (messagesHandler as any)({
			request: mcpRequest,
			url: new URL(mcpRequest.url),
			platform: undefined
		});
		expect(rejected.status).toBe(401);
	});
});
