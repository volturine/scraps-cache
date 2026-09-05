import { describe, expect, it, vi } from 'vitest';
import { isLegacyMessagesPath, isLegacySsePath, mcpSseResponse } from './transport';
import type { McpSession } from './engine';

describe('MCP HTTP transport', () => {
	it('treats only /sse as the legacy endpoint announcement', () => {
		expect(isLegacySsePath('/api/mcp/sse')).toBe(true);
		expect(isLegacySsePath('/api/mcp')).toBe(false);
		expect(isLegacyMessagesPath('/api/mcp/messages')).toBe(true);
		expect(isLegacyMessagesPath('/api/mcp')).toBe(false);
	});

	it('announces the message endpoint only on the legacy SSE path', async () => {
		const session = {
			addSseListener: vi.fn(() => () => undefined)
		} as unknown as McpSession;
		const headers = { Authorization: 'Bearer token' };
		const legacy = mcpSseResponse(
			new Request('https://scrapscache.com/api/mcp/sse', { headers }),
			session,
			new URL('https://scrapscache.com/api/mcp/sse')
		);
		const current = mcpSseResponse(
			new Request('https://scrapscache.com/api/mcp', { headers }),
			session,
			new URL('https://scrapscache.com/api/mcp')
		);
		const legacyReader = legacy.body!.getReader();
		const legacyText = new TextDecoder().decode((await legacyReader.read()).value);
		expect(legacyText).toContain('event: endpoint');
		expect(legacyText).toContain('https://scrapscache.com/api/mcp/messages');
		await legacyReader.cancel();
		await current.body!.cancel();
	});
});
