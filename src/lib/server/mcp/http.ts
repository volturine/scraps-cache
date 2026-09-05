import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { hashMcpToken } from '$lib/mcp/token';
import { mcpResource } from '$lib/mcp/oauth';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { getMcpSessionManager } from './sessionManager';
import {
	mcpBearerToken,
	mcpJsonRpcResponse,
	mcpRequestTooLarge,
	mcpSseResponse,
	readMcpJsonBody
} from './transport';

const RESPONSE_HEADERS = { 'Cache-Control': 'no-store' };

type McpNamespace = {
	idFromName: (name: string) => unknown;
	get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

function namespace(platform: unknown): McpNamespace | undefined {
	return (platform as { env?: { ACCOUNT_MCP_SESSION?: McpNamespace } } | undefined)?.env
		?.ACCOUNT_MCP_SESSION;
}

function acceptsOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return !origin || origin === new URL(request.url).origin;
}

function resourceMetadataUrl(request: Request): string {
	return new URL('/.well-known/oauth-protected-resource', request.url).href;
}

function unauthorized(request: Request, message = 'Missing or invalid MCP bearer token'): Response {
	return json(
		{ error: message },
		{
			status: 401,
			headers: {
				...RESPONSE_HEADERS,
				'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(request)}", resource="${mcpResource(new URL(request.url).origin)}"`
			}
		}
	);
}

function withAuthorizationChallenge(request: Request, response: Response): Response {
	if (response.status !== 401 || response.headers.has('WWW-Authenticate')) return response;
	const headers = new Headers(response.headers);
	headers.set(
		'WWW-Authenticate',
		`Bearer resource_metadata="${resourceMetadataUrl(request)}", resource="${mcpResource(new URL(request.url).origin)}"`
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

async function enforceRateLimit(getClientAddress: () => string): Promise<Response | null> {
	const result = await getPublicApiLimiter().check(`mcp:${clientAddress(getClientAddress)}`, {
		capacity: 120,
		refillWindowMs: 60_000
	});
	return result.allowed ? null : rateLimitResponse(result);
}

async function proxyToDurableObject(
	request: Request,
	platform: unknown,
	token: string
): Promise<Response | null> {
	const binding = namespace(platform);
	if (!binding) return null;
	const stub = binding.get(binding.idFromName(hashMcpToken(token)));
	return stub.fetch(request);
}

export const handleMcpOptions: RequestHandler = async ({ request }) => {
	if (!acceptsOrigin(request)) return new Response(null, { status: 403 });
	return new Response(null, {
		status: 204,
		headers: {
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Protocol-Version',
			'Access-Control-Max-Age': '86400'
		}
	});
};

export const handleMcpGet: RequestHandler = async ({
	request,
	url,
	platform,
	getClientAddress
}) => {
	if (!acceptsOrigin(request)) return new Response(null, { status: 403 });
	const limited = await enforceRateLimit(getClientAddress);
	if (limited) return limited;
	const token = mcpBearerToken(request);
	if (!token) return unauthorized(request);

	const proxied = await proxyToDurableObject(request, platform, token);
	if (proxied) return withAuthorizationChallenge(request, proxied);

	try {
		const session = await getMcpSessionManager().getSessionFromToken(token);
		return mcpSseResponse(request, session, url);
	} catch {
		return unauthorized(request, 'Invalid or revoked MCP token');
	}
};

export const handleMcpPost: RequestHandler = async ({
	request,
	url,
	platform,
	getClientAddress
}) => {
	if (!acceptsOrigin(request)) return new Response(null, { status: 403 });
	const limited = await enforceRateLimit(getClientAddress);
	if (limited) return limited;
	const token = mcpBearerToken(request);
	if (!token) return unauthorized(request);
	const oversized = mcpRequestTooLarge(request);
	if (oversized) return oversized;

	const proxied = await proxyToDurableObject(request, platform, token);
	if (proxied) return withAuthorizationChallenge(request, proxied);

	let session;
	try {
		session = await getMcpSessionManager().getSessionFromToken(token);
	} catch {
		return unauthorized(request, 'Invalid or revoked MCP token');
	}
	const parsed = await readMcpJsonBody(request);
	if (!parsed.ok) return parsed.response;
	return mcpJsonRpcResponse(session, parsed.body, url.pathname);
};
