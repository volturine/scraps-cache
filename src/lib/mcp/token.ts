import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { identityFromSyncKey } from '$lib/syncPairing';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_PREFIX = 'sc_mcp_v2_';
const TOKEN_PATTERN = /^sc_mcp_v2_[A-Za-z0-9_-]{43}$/;
const NONCE_BYTES = 24;

export const MCP_TOKEN_STORAGE_PREFIX = 'scrapscache_mcp_token_';

export type McpTokenGrant = {
	token: string;
	accountId: string;
	wrappedSyncKey: string;
};

export type ResolvedMcpToken = {
	tokenHash: string;
	accountId: string;
	syncKey: string;
	createdAt: number;
};

export type StoredMcpToken = {
	tokenHash: string;
	accountId: string;
	wrappedSyncKey: string;
	createdAt: number;
};

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value');
	const padded =
		value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function wrappingKey(token: string): Uint8Array {
	if (!isMcpToken(token)) throw new Error('Invalid MCP token');
	return sha256(encoder.encode(`scraps-cache-mcp-wrap:v2:${token}`));
}

export function isMcpToken(token: string): boolean {
	return TOKEN_PATTERN.test(token);
}

export function hashMcpToken(token: string): string {
	if (!isMcpToken(token)) throw new Error('Invalid MCP token');
	return bytesToHex(sha256(encoder.encode(`scraps-cache-mcp-token-hash:v2:${token}`)));
}

export function createMcpTokenGrant(syncKey: string): McpTokenGrant {
	const identity = identityFromSyncKey(syncKey);
	const token = `${TOKEN_PREFIX}${bytesToBase64Url(randomBytes(32))}`;
	const nonce = randomBytes(NONCE_BYTES);
	const ciphertext = xchacha20poly1305(wrappingKey(token), nonce).encrypt(encoder.encode(syncKey));
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce);
	packed.set(ciphertext, nonce.length);
	return {
		token,
		accountId: identity.accountId,
		wrappedSyncKey: bytesToBase64Url(packed)
	};
}

export function unwrapMcpSyncKey(token: string, wrappedSyncKey: string): string {
	const packed = base64UrlToBytes(wrappedSyncKey);
	if (packed.length <= NONCE_BYTES) throw new Error('Invalid wrapped MCP key');
	const syncKey = decoder.decode(
		xchacha20poly1305(wrappingKey(token), packed.slice(0, NONCE_BYTES)).decrypt(
			packed.slice(NONCE_BYTES)
		)
	);
	identityFromSyncKey(syncKey);
	return syncKey;
}

export function resolveStoredMcpToken(token: string, row: StoredMcpToken): ResolvedMcpToken | null {
	try {
		const tokenHash = hashMcpToken(token);
		if (tokenHash !== row.tokenHash) return null;
		const syncKey = unwrapMcpSyncKey(token, row.wrappedSyncKey);
		if (identityFromSyncKey(syncKey).accountId !== row.accountId) return null;
		return { tokenHash, accountId: row.accountId, syncKey, createdAt: row.createdAt };
	} catch {
		return null;
	}
}
