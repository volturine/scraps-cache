import { sha256 } from '@noble/hashes/sha2.js';

const encoder = new TextEncoder();

export const MCP_OAUTH_SCOPE = 'mcp';
export const MCP_OAUTH_CODE_TTL_MS = 5 * 60 * 1000;
export const MCP_MANUAL_CLIENT_ID = 'manual';
export const MCP_OAUTH_CLIENT_ID = 'grok';
export const GROK_OAUTH_REDIRECT_URI = 'https://grok.com/connectors-oauth-exchange-code/';

export type OAuthClientId = 'grok' | 'chatgpt' | 'claude' | 'perplexity' | 'hermes';
export type McpGrantClientId = OAuthClientId | typeof MCP_MANUAL_CLIENT_ID;

type RedirectRule =
	| { readonly kind: 'exact'; readonly uri: string }
	| { readonly kind: 'pattern'; readonly test: (uri: string) => boolean };

export type OAuthClient = {
	readonly id: OAuthClientId;
	readonly name: string;
	readonly applicationType: 'web' | 'native';
	readonly browserOrigins: readonly string[];
	readonly redirects: readonly RedirectRule[];
};

const CHATGPT_CONNECTOR = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;
const HERMES_LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/callback$/;

export const OAUTH_CLIENTS: readonly OAuthClient[] = [
	{
		id: 'grok',
		name: 'Grok',
		applicationType: 'web',
		browserOrigins: ['https://grok.com'],
		redirects: [{ kind: 'exact', uri: GROK_OAUTH_REDIRECT_URI }]
	},
	{
		id: 'claude',
		name: 'Claude',
		applicationType: 'web',
		browserOrigins: [],
		redirects: [{ kind: 'exact', uri: 'https://claude.ai/api/mcp/auth_callback' }]
	},
	{
		id: 'perplexity',
		name: 'Perplexity',
		applicationType: 'web',
		browserOrigins: [],
		redirects: [
			'https://www.perplexity.ai/rest/connections/oauth_callback',
			'https://www.perplexity.com/rest/connections/oauth_callback',
			'https://enterprise.perplexity.ai/rest/connections/oauth_callback',
			'https://enterprise.perplexity.com/rest/connections/oauth_callback',
			'https://staging.perplexity.ai/rest/connections/oauth_callback',
			'https://staging.perplexity.com/rest/connections/oauth_callback'
		].map((uri) => ({ kind: 'exact', uri }))
	},
	{
		id: 'chatgpt',
		name: 'ChatGPT',
		applicationType: 'web',
		browserOrigins: [],
		redirects: [
			{ kind: 'exact', uri: 'https://chatgpt.com/connector_platform_oauth_redirect' },
			{ kind: 'pattern', test: (uri) => CHATGPT_CONNECTOR.test(uri) }
		]
	},
	{
		id: 'hermes',
		name: 'Hermes Agent',
		applicationType: 'native',
		browserOrigins: [],
		redirects: [
			{
				kind: 'pattern',
				test: (uri) => {
					const loopback = HERMES_LOOPBACK.exec(uri);
					return loopback !== null && Number(loopback[1]) <= 65535;
				}
			}
		]
	}
];

export const OAUTH_CLIENT_NAMES = Object.fromEntries(
	OAUTH_CLIENTS.map((client) => [client.id, client.name])
) as { readonly [K in OAuthClientId]: string };

export const OAUTH_BROWSER_ORIGINS: readonly string[] = [
	...new Set(OAUTH_CLIENTS.flatMap((client) => client.browserOrigins))
];

function matchesRedirect(client: OAuthClient, uri: string): boolean {
	return client.redirects.some((rule) =>
		rule.kind === 'exact' ? rule.uri === uri : rule.test(uri)
	);
}

export function oauthClientById(id: unknown): OAuthClient | null {
	if (typeof id !== 'string') return null;
	return OAUTH_CLIENTS.find((client) => client.id === id) ?? null;
}

export function oauthClientForRedirect(uri: unknown): OAuthClientId | null {
	if (typeof uri !== 'string') return null;
	return OAUTH_CLIENTS.find((client) => matchesRedirect(client, uri))?.id ?? null;
}

export function isOAuthClientRedirect(clientId: unknown, uri: unknown): boolean {
	if (typeof uri !== 'string') return false;
	const client = oauthClientById(clientId);
	return client !== null && matchesRedirect(client, uri);
}

export function isOAuthBrowserOrigin(origin: string): boolean {
	return OAUTH_BROWSER_ORIGINS.includes(origin);
}

export function isMcpGrantClientId(value: unknown): value is McpGrantClientId {
	return value === MCP_MANUAL_CLIENT_ID || oauthClientById(value) !== null;
}

export function mcpGrantName(clientId: string): string {
	if (clientId === MCP_MANUAL_CLIENT_ID) return 'Manual setup';
	return oauthClientById(clientId)?.name ?? 'AI client';
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
