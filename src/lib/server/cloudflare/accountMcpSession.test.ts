import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { testDb, cleanupTestDbs } from '$lib/server/testDb';
import type { Db } from '$lib/server/db';
import { closeMcpRevocationStore } from '$lib/server/mcp/revocation';
import { AccountMcpSession } from '../../../../cf/accountMcpSession';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpToken } from '$lib/mcp/token';

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

describe('AccountMcpSession Durable Object', () => {
	let identity: ReturnType<typeof createSyncIdentity>;
	let token: string;

	beforeEach(() => {
		mockDb = testDb();
		identity = createSyncIdentity();
		token = createMcpToken(identity.syncKey);
	});

	afterEach(() => {
		closeMcpRevocationStore();
		cleanupTestDbs();
	});

	it('handles SSE connection and JSON-RPC dispatch in Durable Object', async () => {
		const doSession = new AccountMcpSession({} as any);

		// 1. Connect via SSE
		const sseReq = new Request(`https://scrapscache.com/sse?token=${token}`, {
			headers: { Accept: 'text/event-stream' }
		});
		const sseRes = await doSession.fetch(sseReq);
		expect(sseRes.status).toBe(200);
		expect(sseRes.headers.get('Content-Type')).toBe('text/event-stream');

		const reader = sseRes.body!.getReader();
		const decoder = new TextDecoder();
		const chunk1 = await reader.read();
		const text = decoder.decode(chunk1.value);
		expect(text).toContain('event: endpoint');

		const match = text.match(/sessionId=([a-zA-Z0-9_.-]+)/);
		expect(match).toBeTruthy();
		const sessionId = match![1];

		// 2. Send ping to messages
		const pingReq = new Request(`https://scrapscache.com/messages?sessionId=${sessionId}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 10,
				method: 'ping'
			})
		});
		const pingRes = await doSession.fetch(pingReq);
		expect(pingRes.status).toBe(200);
		const pingJson = await pingRes.json();
		expect(pingJson).toEqual({ jsonrpc: '2.0', id: 10, result: {} });

		reader.cancel();
	});

	it('auto-rehydrates session from token on messages endpoint when memory is empty', async () => {
		const doSession = new AccountMcpSession({} as any);

		// Do not connect SSE first; directly call messages with token param
		const toolsReq = new Request(
			`https://scrapscache.com/messages?sessionId=${identity.accountId}.test&token=${encodeURIComponent(token)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 20,
					method: 'tools/list'
				})
			}
		);
		const toolsRes = await doSession.fetch(toolsReq);
		expect(toolsRes.status).toBe(200);
		const toolsJson = (await toolsRes.json()) as any;
		expect(toolsJson.result.tools).toBeDefined();
		expect(toolsJson.result.tools.some((t: any) => t.name === 'list_notes')).toBe(true);
		expect(toolsJson.result.tools.some((t: any) => t.name === 'search_notes')).toBe(true);
	});
});
