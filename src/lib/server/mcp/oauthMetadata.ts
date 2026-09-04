import { json } from '@sveltejs/kit';
import { MCP_OAUTH_SCOPE, mcpResource } from '$lib/mcp/oauth';

const METADATA_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Cache-Control': 'public, max-age=3600'
};

export function authorizationServerMetadata(origin: string): Response {
	return json(
		{
			issuer: origin,
			authorization_endpoint: new URL('/mcp/oauth/authorize', origin).href,
			token_endpoint: new URL('/api/mcp/oauth/token', origin).href,
			scopes_supported: [MCP_OAUTH_SCOPE],
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none']
		},
		{ headers: METADATA_HEADERS }
	);
}

export function protectedResourceMetadata(origin: string): Response {
	return json(
		{
			resource: mcpResource(origin),
			authorization_servers: [origin],
			scopes_supported: [MCP_OAUTH_SCOPE],
			bearer_methods_supported: ['header']
		},
		{ headers: METADATA_HEADERS }
	);
}
