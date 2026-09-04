import { describe, expect, it } from 'vitest';
import { createSyncIdentity } from '$lib/syncPairing';
import { createMcpToken, verifyMcpToken } from './token';

describe('mcp token', () => {
	it('creates and verifies a valid token', () => {
		const identity = createSyncIdentity();
		const token = createMcpToken(identity.syncKey);
		expect(token.startsWith('sc_mcp_v1_')).toBe(true);

		const result = verifyMcpToken(token);
		expect(result.valid).toBe(true);
		expect(result.accountId).toBe(identity.accountId);
		expect(result.syncKey).toBe(identity.syncKey);
		expect(typeof result.createdAt).toBe('number');
	});

	it('rejects tampered tokens', () => {
		const identity = createSyncIdentity();
		const token = createMcpToken(identity.syncKey);
		const tampered = token.slice(0, -4) + 'zzzz';
		const result = verifyMcpToken(tampered);
		expect(result.valid).toBe(false);
	});

	it('rejects non-token strings', () => {
		expect(verifyMcpToken('').valid).toBe(false);
		expect(verifyMcpToken('bearer 123').valid).toBe(false);
		expect(verifyMcpToken('sc_mcp_v2_abc').valid).toBe(false);
	});
});
