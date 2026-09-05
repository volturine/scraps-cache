import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { oauthClientById, oauthClientForRedirect, MCP_OAUTH_SCOPE } from '$lib/mcp/oauth';
import { InvalidRequestBody, readJsonBody } from '$lib/server/request';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

const MAX_BODY_BYTES = 4096;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

type ClientMetadata = {
	redirect_uris?: unknown;
	token_endpoint_auth_method?: unknown;
	client_name?: unknown;
};

function registrationError(error: string, description: string): Response {
	return json(
		{ error, error_description: description },
		{ status: 400, headers: NO_STORE_HEADERS }
	);
}

function callbackDescription(uri: unknown): string {
	if (typeof uri !== 'string') return 'not a URL string';
	try {
		const url = new URL(uri);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unsupported URL scheme';
		return (
			`${url.origin}${url.pathname}`.slice(0, 256) +
			(url.search ? ' (query present)' : '') +
			(url.hash ? ' (fragment present)' : '')
		);
	} catch {
		return 'invalid URL';
	}
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
		(metadata.client_name !== undefined &&
			(typeof metadata.client_name !== 'string' || metadata.client_name.length > 200))
	) {
		return registrationError('invalid_client_metadata', 'Unsupported OAuth client metadata');
	}

	const redirects = metadata.redirect_uris;
	if (!Array.isArray(redirects) || redirects.length === 0) {
		return registrationError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
	}
	const unsupportedIndex = redirects.findIndex((uri) => !oauthClientForRedirect(uri));
	if (unsupportedIndex !== -1) {
		return registrationError(
			'invalid_redirect_uri',
			`Unsupported redirect_uris[${unsupportedIndex}]: ${callbackDescription(redirects[unsupportedIndex])}`
		);
	}
	const client = oauthClientById(oauthClientForRedirect(redirects[0]));
	if (!client || !redirects.every((uri) => oauthClientForRedirect(uri) === client.id)) {
		return registrationError(
			'invalid_redirect_uri',
			'Use supported callbacks belonging to one OAuth client'
		);
	}

	return json(
		{
			client_id: client.id,
			client_name: metadata.client_name,
			redirect_uris: [...new Set(redirects)],
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			scope: MCP_OAUTH_SCOPE,
			application_type: client.applicationType
		},
		{ status: 201, headers: NO_STORE_HEADERS }
	);
};
