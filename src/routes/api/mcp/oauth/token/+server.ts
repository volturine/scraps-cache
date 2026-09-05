import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	isOAuthBrowserOrigin,
	isOAuthClientRedirect,
	oauthClientById,
	MCP_OAUTH_SCOPE,
	mcpResource
} from '$lib/mcp/oauth';
import { createMcpTokenGrant, MCP_TOKEN_TTL_MS } from '$lib/mcp/token';
import { getMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { getMcpTokenStore, McpAccessDisabledError } from '$lib/server/mcp/tokenStore';
import { endMcpSessions } from '$lib/server/mcp/liveSessions';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

const MAX_BODY_BYTES = 8192;

function corsHeaders(request: Request): Record<string, string> {
	const origin = request.headers.get('origin');
	return {
		...(origin && isOAuthBrowserOrigin(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
		'Cache-Control': 'no-store',
		Pragma: 'no-cache',
		Vary: 'Origin'
	};
}

export const OPTIONS: RequestHandler = ({ request }) =>
	new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Headers': 'Content-Type',
			'Access-Control-Allow-Methods': 'POST',
			...corsHeaders(request)
		}
	});

function oauthError(request: Request, error: string, description: string, status = 400): Response {
	return json({ error, error_description: description }, { status, headers: corsHeaders(request) });
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
		return oauthError(
			request,
			'invalid_request',
			'Content-Type must be application/x-www-form-urlencoded'
		);
	}

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_BODY_BYTES) {
		return oauthError(request, 'invalid_request', 'Request body is too large', 413);
	}
	let rawBody: string;
	try {
		rawBody = await request.text();
	} catch {
		return oauthError(request, 'invalid_request', 'Could not read request body');
	}
	if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
		return oauthError(request, 'invalid_request', 'Request body is too large', 413);
	}

	const form = new URLSearchParams(rawBody);
	const grantType = form.get('grant_type');
	const clientId = form.get('client_id') ?? '';
	const resource = form.get('resource') ?? mcpResource(url.origin);
	const client = oauthClientById(clientId);
	if (!client || resource !== mcpResource(url.origin)) {
		return oauthError(request, 'invalid_grant', 'Authorization code parameters do not match');
	}

	if (grantType === 'refresh_token') {
		try {
			const rotated = await getMcpTokenStore().refresh(form.get('refresh_token') ?? '', client.id);
			if (!rotated) {
				return oauthError(request, 'invalid_grant', 'Refresh token is invalid or expired');
			}
			await endMcpSessions(rotated.accountId, rotated.replacedTokenHashes, platform);
			return json(
				{
					access_token: rotated.token,
					token_type: 'Bearer',
					scope: MCP_OAUTH_SCOPE,
					expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000),
					refresh_token: rotated.refreshToken
				},
				{ headers: corsHeaders(request) }
			);
		} catch (error) {
			if (error instanceof McpAccessDisabledError) {
				return oauthError(request, 'invalid_grant', 'Hosted MCP is not enabled for this account');
			}
			return oauthError(request, 'server_error', 'Could not issue an access token', 500);
		}
	}

	if (grantType !== 'authorization_code') {
		return oauthError(
			request,
			'unsupported_grant_type',
			'Only authorization_code and refresh_token are supported'
		);
	}
	const code = form.get('code') ?? '';
	const redirectUri = form.get('redirect_uri') ?? '';
	const codeVerifier = form.get('code_verifier') ?? '';
	if (!isOAuthClientRedirect(client.id, redirectUri)) {
		return oauthError(request, 'invalid_grant', 'Authorization code parameters do not match');
	}

	const exchanged = await getMcpOAuthStore().consumeCode({
		code,
		clientId,
		redirectUri,
		codeVerifier,
		resource
	});
	if (!exchanged) {
		return oauthError(
			request,
			'invalid_grant',
			'Authorization code is invalid, expired, or already used'
		);
	}

	try {
		const grant = createMcpTokenGrant(exchanged.syncKey);
		const issued = await getMcpTokenStore().issue(
			exchanged.accountId,
			grant.token,
			grant.wrappedSyncKey,
			client.id
		);
		await endMcpSessions(exchanged.accountId, issued.replacedTokenHashes, platform);
		return json(
			{
				access_token: grant.token,
				token_type: 'Bearer',
				scope: MCP_OAUTH_SCOPE,
				expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000),
				refresh_token: issued.refreshToken
			},
			{ headers: corsHeaders(request) }
		);
	} catch (error) {
		if (error instanceof McpAccessDisabledError) {
			return oauthError(request, 'invalid_grant', 'Hosted MCP is not enabled for this account');
		}
		return oauthError(request, 'server_error', 'Could not issue an access token', 500);
	}
};
