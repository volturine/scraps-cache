import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

export const MCP_OAUTH_CLIENT_ID = 'grok';
export const MCP_OAUTH_SCOPE = 'mcp';
export const GROK_OAUTH_REDIRECT_URI = 'https://grok.com/connectors-oauth-exchange-code/';
export const MCP_OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

export const OAUTH_CLIENT_NAMES = {
	grok: 'Grok',
	chatgpt: 'ChatGPT',
	claude: 'Claude',
	perplexity: 'Perplexity',
	hermes: 'Hermes Agent'
} as const;

export function oauthClientForRedirect(uri: unknown): keyof typeof OAUTH_CLIENT_NAMES | null {
	if (uri === GROK_OAUTH_REDIRECT_URI) return 'grok';
	if (typeof uri !== 'string') return null;
	if (uri === 'https://claude.ai/api/mcp/auth_callback') return 'claude';
	if (
		uri === 'https://www.perplexity.ai/rest/connections/oauth_callback' ||
		uri === 'https://www.perplexity.com/rest/connections/oauth_callback' ||
		uri === 'https://enterprise.perplexity.ai/rest/connections/oauth_callback' ||
		uri === 'https://enterprise.perplexity.com/rest/connections/oauth_callback' ||
		uri === 'https://staging.perplexity.ai/rest/connections/oauth_callback' ||
		uri === 'https://staging.perplexity.com/rest/connections/oauth_callback'
	)
		return 'perplexity';
	const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/callback$/.exec(uri);
	if (loopback && Number(loopback[1]) <= 65535) return 'hermes';
	if (
		uri === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
		/^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri)
	)
		return 'chatgpt';
	return null;
}

export function isOAuthClientRedirect(clientId: unknown, uri: unknown): boolean {
	const client = oauthClientForRedirect(uri);
	return client !== null && clientId === client;
}

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
