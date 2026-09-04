import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountMcpSession } from '../../../../cf/accountMcpSession';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpTokenGrant, hashMcpToken, type ResolvedMcpToken } from '$lib/mcp/token';

describe('AccountMcpSession Durable Object', () => {
	let token: string;
	let resolved: ResolvedMcpToken;

	beforeEach(() => {
		const identity = createSyncIdentity();
		token = createMcpTokenGrant(identity.syncKey).token;
		resolved = {
			tokenHash: hashMcpToken(token),
			accountId: identity.accountId,
			syncKey: identity.syncKey,
			createdAt: Date.now()
		};
	});

	it('keeps decrypted material only in memory and requires the bearer on every request', async () => {
		const storage = { get: vi.fn(), put: vi.fn(), setAlarm: vi.fn(), deleteAll: vi.fn() };
		const durableObject = new AccountMcpSession({ storage } as any, undefined, async (candidate) =>
			candidate === token ? resolved : null
		);

		const sseRequest = new Request('https://scrapscache.com/api/mcp/sse', {
			headers: { Authorization: `Bearer ${token}` }
		});
		const sseResponse = await durableObject.fetch(sseRequest);
		expect(sseResponse.status).toBe(200);
		const reader = sseResponse.body!.getReader();
		const text = new TextDecoder().decode((await reader.read()).value);
		expect(text).toContain('data: https://scrapscache.com/api/mcp/messages');
		expect(text).not.toContain('token=');

		const unauthenticated = await durableObject.fetch(
			new Request('https://scrapscache.com/api/mcp/messages?sessionId=guessed', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
			})
		);
		expect(unauthenticated.status).toBe(401);
		expect(storage.get).not.toHaveBeenCalled();
		expect(storage.put).not.toHaveBeenCalled();
		expect(storage.setAlarm).not.toHaveBeenCalled();

		expect(
			(await durableObject.fetch(new Request('https://mcp-session/revoke', { method: 'DELETE' })))
				.status
		).toBe(204);
		expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: close');
		expect((await reader.read()).done).toBe(true);
	});

	it('rehydrates from an authorized request and fails closed after revocation', async () => {
		let active = true;
		const durableObject = new AccountMcpSession({} as any, undefined, async (candidate) =>
			active && candidate === token ? resolved : null
		);
		const request = () =>
			new Request('https://scrapscache.com/api/mcp', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
			});

		const response = await durableObject.fetch(request());
		expect(response.status).toBe(200);
		expect(((await response.json()) as any).result.tools).toBeDefined();

		const notificationResponse = await durableObject.fetch(
			new Request('https://scrapscache.com/api/mcp', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
			})
		);
		expect(notificationResponse.status).toBe(202);
		expect(await notificationResponse.text()).toBe('');

		active = false;
		expect((await durableObject.fetch(request())).status).toBe(401);
	});

	it('keeps concurrent clients on the same bearer session connected', async () => {
		const durableObject = new AccountMcpSession({} as any, undefined, async (candidate) =>
			candidate === token ? resolved : null
		);
		const connect = () =>
			durableObject.fetch(
				new Request('https://scrapscache.com/api/mcp/sse', {
					headers: { Authorization: `Bearer ${token}` }
				})
			);
		const readers = await Promise.all(
			(await Promise.all([connect(), connect()])).map(async (response) => {
				const reader = response.body!.getReader();
				await reader.read();
				return reader;
			})
		);
		const message = await durableObject.fetch(
			new Request('https://scrapscache.com/api/mcp/messages', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })
			})
		);
		expect(message.status).toBe(202);
		for (const reader of readers) {
			expect(new TextDecoder().decode((await reader.read()).value)).toContain('"id":3');
			await reader.cancel();
		}
	});
});
