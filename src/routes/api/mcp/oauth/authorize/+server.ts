import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	isOAuthClientRedirect,
	MCP_OAUTH_SCOPE,
	isPkceChallenge,
	mcpResource
} from '$lib/mcp/oauth';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getMcpOAuthStore } from '$lib/server/mcp/oauthStore';
import { InvalidRequestBody, readJsonBody } from '$lib/server/request';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { getMcpAccessStore } from '$lib/server/mcp/accessStore';

const MAX_BODY_BYTES = 4096;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

type AuthorizationBody = {
	responseType?: unknown;
	clientId?: unknown;
	redirectUri?: unknown;
	scope?: unknown;
	state?: unknown;
	codeChallenge?: unknown;
	codeChallengeMethod?: unknown;
	resource?: unknown;
	code?: unknown;
	wrappedSyncKey?: unknown;
};

function invalidRequest(message: string): Response {
	return json(
		{ error: 'invalid_request', error_description: message },
		{ status: 400, headers: NO_STORE_HEADERS }
	);
}

export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
	const limited = await getPublicApiLimiter().check(
		`mcp-oauth-authorize:${clientAddress(getClientAddress)}`,
		{ capacity: 30, refillWindowMs: 60_000 }
	);
	if (!limited.allowed) return rateLimitResponse(limited);

	const accountId = await getSyncAuth().authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Unauthorized' }, { status: 401 });
	if (!(await getMcpAccessStore().isEnabled(accountId))) {
		return json(
			{ error: 'access_denied', error_description: 'Hosted MCP is not enabled for this account' },
			{ status: 403, headers: NO_STORE_HEADERS }
		);
	}

	let body: AuthorizationBody;
	try {
		body = (await readJsonBody(request, MAX_BODY_BYTES)) as AuthorizationBody;
	} catch (error) {
		return invalidRequest(
			error instanceof InvalidRequestBody ? error.message : 'Invalid request body'
		);
	}

	const resource = mcpResource(url.origin);
	if (
		body.responseType !== 'code' ||
		typeof body.clientId !== 'string' ||
		typeof body.redirectUri !== 'string' ||
		!isOAuthClientRedirect(body.clientId, body.redirectUri) ||
		body.scope !== MCP_OAUTH_SCOPE ||
		body.codeChallengeMethod !== 'S256' ||
		typeof body.codeChallenge !== 'string' ||
		!isPkceChallenge(body.codeChallenge) ||
		(body.resource !== undefined && body.resource !== resource) ||
		typeof body.code !== 'string' ||
		typeof body.wrappedSyncKey !== 'string' ||
		(body.state !== undefined && (typeof body.state !== 'string' || body.state.length > 512))
	) {
		return invalidRequest('Unsupported OAuth authorization parameters');
	}

	try {
		await getMcpOAuthStore().createCode(accountId, {
			token: body.code,
			wrappedSyncKey: body.wrappedSyncKey,
			clientId: body.clientId,
			redirectUri: body.redirectUri,
			codeChallenge: body.codeChallenge,
			resource
		});
	} catch {
		return invalidRequest('Invalid OAuth authorization grant');
	}

	const redirect = new URL(body.redirectUri);
	redirect.searchParams.set('code', body.code);
	if (typeof body.state === 'string') redirect.searchParams.set('state', body.state);
	redirect.searchParams.set('iss', url.origin);
	return json({ redirectTo: redirect.href }, { headers: NO_STORE_HEADERS });
};
