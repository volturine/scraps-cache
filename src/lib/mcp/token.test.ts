import { describe, expect, it } from 'vitest';
import { createSyncIdentity } from '$lib/syncPairing';
import {
	createMcpTokenGrant,
	hashMcpToken,
	isMcpToken,
	resolveStoredMcpToken,
	unwrapMcpSyncKey
} from './token';

describe('mcp token', () => {
	it('creates an opaque token and an independently stored key envelope', () => {
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		expect(isMcpToken(grant.token)).toBe(true);
		expect(grant.token).not.toContain(identity.syncKey);
		expect(unwrapMcpSyncKey(grant.token, grant.wrappedSyncKey)).toBe(identity.syncKey);
	});

	it('cannot unwrap the key with a different bearer token', () => {
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		const other = createMcpTokenGrant(identity.syncKey);
		expect(() => unwrapMcpSyncKey(other.token, grant.wrappedSyncKey)).toThrow();
	});

	it('binds a stored grant to its token hash and account', () => {
		const identity = createSyncIdentity();
		const grant = createMcpTokenGrant(identity.syncKey);
		const row = {
			tokenHash: hashMcpToken(grant.token),
			accountId: identity.accountId,
			wrappedSyncKey: grant.wrappedSyncKey,
			createdAt: 123
		};
		expect(resolveStoredMcpToken(grant.token, row)).toMatchObject({
			accountId: identity.accountId,
			syncKey: identity.syncKey,
			createdAt: 123
		});
		expect(resolveStoredMcpToken(grant.token, { ...row, accountId: 'other' })).toBeNull();
	});

	it('rejects malformed tokens', () => {
		expect(isMcpToken('')).toBe(false);
		expect(isMcpToken('bearer 123')).toBe(false);
		expect(isMcpToken('sc_mcp_v2_abc')).toBe(false);
	});
});
