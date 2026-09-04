import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	GROK_OAUTH_REDIRECT_URI,
	MCP_OAUTH_CLIENT_ID,
	MCP_OAUTH_SCOPE,
	mcpResource
} from '$lib/mcp/oauth';
import { createMcpTokenGrant } from '$lib/mcp/token';
import { getMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { getMcpTokenStore } from '$lib/server/mcp/tokenStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

const MAX_BODY_BYTES = 8192;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

function oauthError(error: string, description: string, status = 400): Response {
	return json({ error, error_description: description }, { status, headers: NO_STORE_HEADERS });
}

export const POST: RequestHandler = async ({ request, url, platform, getClientAddress }) => {
	const limited = await getPublicApiLimiter().check(
		`mcp-oauth-token:${clientAddress(getClientAddress)}`,
		{ capacity: 60, refillWindowMs: 60_000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	if (
		!request.headers
			.get('content-type')
			?.toLowerCase()
			.startsWith('application/x-www-form-urlencoded')
	) {
		return oauthError('invalid_request', 'Content-Type must be application/x-www-form-urlencoded');
	}

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_BODY_BYTES) {
		return oauthError('invalid_request', 'Request body is too large', 413);
	}
	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return oauthError('invalid_request', 'Could not read request body');
	}
	if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
		return oauthError('invalid_request', 'Request body is too large', 413);
	}

	const form = new URLSearchParams(rawBody);
	if (form.get('grant_type') !== 'authorization_code') {
		return oauthError('unsupported_grant_type', 'Only authorization_code is supported');
	}
	const code = form.get('code') ?? '';
	const clientId = form.get('client_id') ?? '';
	const redirectUri = form.get('redirect_uri') ?? '';
	const codeVerifier = form.get('code_verifier') ?? '';
	const resource = form.get('resource') ?? mcpResource(url.origin);
	if (
		clientId !== MCP_OAUTH_CLIENT_ID ||
		redirectUri !== GROK_OAUTH_REDIRECT_URI ||
		resource !== mcpResource(url.origin)
	) {
		return oauthError('invalid_grant', 'Authorization code parameters do not match');
	}

	const exchanged = await getMcpOAuthStore().consumeCode({
		code,
		clientId,
		redirectUri,
		codeVerifier,
		resource
	});
	if (!exchanged) {
		return oauthError('invalid_grant', 'Authorization code is invalid, expired, or already used');
	}

	try {
		const grant = createMcpTokenGrant(exchanged.syncKey);
		const { replacedTokenHashes } = await getMcpTokenStore().issue(
			exchanged.accountId,
			grant.token,
			grant.wrappedSyncKey,
			false
		);
		await endMcpSessions(exchanged.accountId, replacedTokenHashes, platform);
		return json(
			{
				access_token: grant.token,
				token_type: 'Bearer',
				scope: MCP_OAUTH_SCOPE
			},
			{ headers: NO_STORE_HEADERS }
		);
	} catch {
		return oauthError('server_error', 'Could not issue an access token', 500);
	}
};
