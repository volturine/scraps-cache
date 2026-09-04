import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

export const MCP_OAUTH_CLIENT_ID = 'grok';
export const MCP_OAUTH_SCOPE = 'mcp';
export const GROK_OAUTH_REDIRECT_URI = 'https://grok.com/connectors-oauth-exchange-code/';
export const MCP_OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function isPkceChallenge(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isPkceVerifier(value: string): boolean {
	return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function pkceChallenge(verifier: string): string {
	if (!isPkceVerifier(verifier)) throw new Error('Invalid PKCE verifier');
	return bytesToBase64Url(sha256(encoder.encode(verifier)));
}

export function mcpResource(origin: string): string {
	return new URL('/api/mcp', origin).href;
}
