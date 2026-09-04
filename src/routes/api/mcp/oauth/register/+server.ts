import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { GROK_OAUTH_REDIRECT_URI, MCP_OAUTH_CLIENT_ID, MCP_OAUTH_SCOPE } from '$lib/mcp/oauth';
import { InvalidRequestBody, readJsonBody } from '$lib/server/request';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

const MAX_BODY_BYTES = 4096;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

type ClientMetadata = {
	redirect_uris?: unknown;
	token_endpoint_auth_method?: unknown;
	grant_types?: unknown;
	response_types?: unknown;
	scope?: unknown;
	application_type?: unknown;
	client_name?: unknown;
};

function registrationError(error: string, description: string): Response {
	return json(
		{ error, error_description: description },
		{ status: 400, headers: NO_STORE_HEADERS }
	);
}

function isOnly(value: unknown, expected: string): boolean {
	return (
		value === undefined || (Array.isArray(value) && value.length === 1 && value[0] === expected)
	);
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = await getPublicApiLimiter().check(
		`mcp-oauth-register:${clientAddress(getClientAddress)}`,
		{ capacity: 15, refillWindowMs: 60_000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);

	if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
		return registrationError('invalid_client_metadata', 'Content-Type must be application/json');
	}

	let metadata: ClientMetadata;
	try {
		metadata = (await readJsonBody(request, MAX_BODY_BYTES)) as ClientMetadata;
	} catch (error) {
		return registrationError(
			'invalid_client_metadata',
			error instanceof InvalidRequestBody ? error.message : 'Invalid client metadata'
		);
	}

	if (
		!metadata ||
		typeof metadata !== 'object' ||
		Array.isArray(metadata) ||
		(metadata.token_endpoint_auth_method !== undefined &&
			metadata.token_endpoint_auth_method !== 'none') ||
		!isOnly(metadata.grant_types, 'authorization_code') ||
		!isOnly(metadata.response_types, 'code') ||
		(metadata.scope !== undefined && metadata.scope !== MCP_OAUTH_SCOPE) ||
		(metadata.application_type !== undefined && metadata.application_type !== 'web') ||
		(metadata.client_name !== undefined &&
			(typeof metadata.client_name !== 'string' || metadata.client_name.length > 200))
	) {
		return registrationError('invalid_client_metadata', 'Unsupported OAuth client metadata');
	}

	if (
		!Array.isArray(metadata.redirect_uris) ||
		metadata.redirect_uris.length !== 1 ||
		metadata.redirect_uris[0] !== GROK_OAUTH_REDIRECT_URI
	) {
		return registrationError('invalid_redirect_uri', 'Only the Grok OAuth callback is allowed');
	}

	return json(
		{
			client_id: MCP_OAUTH_CLIENT_ID,
			client_name: metadata.client_name,
			redirect_uris: [GROK_OAUTH_REDIRECT_URI],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code'],
			response_types: ['code'],
			scope: MCP_OAUTH_SCOPE,
			application_type: 'web'
		},
		{ status: 201, headers: NO_STORE_HEADERS }
	);
};
