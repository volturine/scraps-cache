import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { testDb, cleanupTestDbs } from '$lib/server/testDb';
import type { Db } from '$lib/server/db';
import { closeMcpRevocationStore } from '$lib/server/mcp/revocation';
import { closeMcpSessionManager } from '$lib/server/mcp/sessionManager';

let mockDb: Db;

vi.mock('$lib/server/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/db')>();
	return {
		...actual,
		getDb: () => {
			if (!mockDb) mockDb = testDb();
			return mockDb;
		}
	};
});

import { GET as sseHandler } from './sse/+server';
import { POST as messagesHandler, extractAccountIdFromSessionId } from './messages/+server';
import { POST as revokeHandler } from './revoke/+server';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpToken } from '$lib/mcp/token';

describe('mcp api routes e2e', () => {
	let identity: ReturnType<typeof createSyncIdentity>;
	let token: string;

	beforeEach(() => {
		mockDb = testDb();
		identity = createSyncIdentity();
		token = createMcpToken(identity.syncKey);
	});

	afterEach(() => {
		closeMcpRevocationStore();
		closeMcpSessionManager();
		cleanupTestDbs();
	});

	it('handles SSE connection and message exchange', async () => {
		// 1. Initiate SSE connection
		const sseReq = new Request(`http://localhost:5173/api/mcp/sse?token=${token}`, {
			headers: { Accept: 'text/event-stream' }
		});
		const sseRes = await (sseHandler as any)({
			request: sseReq,
			url: new URL(sseReq.url),
			platform: undefined
		});
		expect(sseRes.status).toBe(200);

		const reader = sseRes.body.getReader();
		const decoder = new TextDecoder();
		const chunk1 = await reader.read();
		const text = decoder.decode(chunk1.value);
		expect(text).toContain('event: endpoint');

		const match = text.match(/sessionId=([a-zA-Z0-9_.~-]+)/);
		expect(match).toBeTruthy();
		const sessionId = match![1];

		// 2. Send initialize
		const initReq = new Request(`http://localhost:5173/api/mcp/messages?sessionId=${sessionId}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: { protocolVersion: '2024-11-05' }
			})
		});
		const initRes = await (messagesHandler as any)({
			request: initReq,
			url: new URL(initReq.url),
			platform: undefined
		});
		expect(initRes.status).toBe(200);
		const initBody = await initRes.json();
		expect(initBody.result.protocolVersion).toBe('2024-11-05');
		expect(initBody.result.serverInfo.name).toBe('scrapscache-mcp');

		// 3. Call tools/list
		const toolsReq = new Request(`http://localhost:5173/api/mcp/messages?sessionId=${sessionId}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list'
			})
		});
		const toolsRes = await (messagesHandler as any)({
			request: toolsReq,
			url: new URL(toolsReq.url),
			platform: undefined
		});
		expect(toolsRes.status).toBe(200);
		const toolsBody = await toolsRes.json();
		expect(toolsBody.result.tools.some((t: any) => t.name === 'search_notes')).toBe(true);
		expect(toolsBody.result.tools.some((t: any) => t.name === 'list_notes')).toBe(true);
		expect(toolsBody.result.tools.some((t: any) => t.name === 'open_note')).toBe(true);
		expect(toolsBody.result.tools.some((t: any) => t.name === 'create_note')).toBe(true);

		// Clean up stream
		reader.cancel();
	});

	it('correctly extracts accountId from complex sessionIds', () => {
		// SessionId with dot
		expect(
			extractAccountIdFromSessionId('pkEsDT-vPXEjyAdOqpeGI_dH.eab08c52-679b-4aec-aa0d-ed6d68cf3af4')
		).toBe('pkEsDT-vPXEjyAdOqpeGI_dH');

		// SessionId with tilde
		expect(
			extractAccountIdFromSessionId('pkEsDT-vPXEjyAdOqpeGI_dH~eab08c52-679b-4aec-aa0d-ed6d68cf3af4')
		).toBe('pkEsDT-vPXEjyAdOqpeGI_dH');

		// Legacy sessionId with underscore even when accountId has internal underscore
		expect(
			extractAccountIdFromSessionId('pkEsDT-vPXEjyAdOqpeGI_dH_eab08c52-679b-4aec-aa0d-ed6d68cf3af4')
		).toBe('pkEsDT-vPXEjyAdOqpeGI_dH');

		// Extraction via token fallback
		expect(extractAccountIdFromSessionId('invalid_session_id', token)).toBe(identity.accountId);
	});

	it('rejects unauthenticated or invalid tokens on SSE', async () => {
		const sseReq = new Request('http://localhost:5173/api/mcp/sse?token=invalid_token');
		const res = await (sseHandler as any)({
			request: sseReq,
			url: new URL(sseReq.url),
			platform: undefined
		});
		expect(res.status).toBe(401);
	});

	it('revokes tokens and rejects subsequent sessions', async () => {
		// Revoke with the token
		const revokeReq = new Request('http://localhost:5173/api/mcp/revoke', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ token })
		});
		const revokeRes = await (revokeHandler as any)({ request: revokeReq });
		expect(revokeRes.status).toBe(200);
		const revokeBody = await revokeRes.json();
		expect(revokeBody.success).toBe(true);

		// Subsequent SSE with the same token created prior to revocation should be 401
		const sseReq = new Request(`http://localhost:5173/api/mcp/sse?token=${token}`);
		const sseRes = await (sseHandler as any)({
			request: sseReq,
			url: new URL(sseReq.url),
			platform: undefined
		});
		expect(sseRes.status).toBe(401);
	});
});
