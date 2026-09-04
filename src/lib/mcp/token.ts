import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { identityFromSyncKey } from '$lib/syncPairing';

const encoder = new TextEncoder();

export type McpTokenPayload = {
	v: 1;
	accountId: string;
	syncKey: string;
	createdAt: number;
	sig: string;
};

export function computeMcpSignature(accountId: string, syncKey: string, createdAt: number): string {
	const data = encoder.encode(`scraps-cache-mcp-token:v1:${accountId}:${syncKey}:${createdAt}`);
	return bytesToHex(sha256(data));
}

export function createMcpToken(syncKey: string, createdAt = Date.now()): string {
	const identity = identityFromSyncKey(syncKey);
	const sig = computeMcpSignature(identity.accountId, syncKey, createdAt);
	const payload: McpTokenPayload = {
		v: 1,
		accountId: identity.accountId,
		syncKey,
		createdAt,
		sig
	};
	const json = JSON.stringify(payload);
	const encoded = btoa(json).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
	return `sc_mcp_v1_${encoded}`;
}

export function verifyMcpToken(tokenString: string): {
	valid: boolean;
	accountId?: string;
	syncKey?: string;
	createdAt?: number;
	error?: string;
} {
	if (!tokenString || typeof tokenString !== 'string' || !tokenString.startsWith('sc_mcp_v1_')) {
		return { valid: false, error: 'Invalid token prefix' };
	}
	const base64 = tokenString.slice('sc_mcp_v1_'.length);
	try {
		const padded =
			base64.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (base64.length % 4)) % 4);
		const json = atob(padded);
		const payload = JSON.parse(json) as McpTokenPayload;
		if (
			payload.v !== 1 ||
			!payload.accountId ||
			!payload.syncKey ||
			!payload.createdAt ||
			!payload.sig
		) {
			return { valid: false, error: 'Malformed token payload' };
		}
		const expectedSig = computeMcpSignature(payload.accountId, payload.syncKey, payload.createdAt);
		if (expectedSig !== payload.sig) {
			return { valid: false, error: 'Invalid token signature' };
		}
		const identity = identityFromSyncKey(payload.syncKey);
		if (identity.accountId !== payload.accountId) {
			return { valid: false, error: 'Account ID mismatch' };
		}
		return {
			valid: true,
			accountId: payload.accountId,
			syncKey: payload.syncKey,
			createdAt: payload.createdAt
		};
	} catch {
		return { valid: false, error: 'Failed to decode token' };
	}
}
