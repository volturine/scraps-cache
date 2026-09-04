import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { hashMcpToken, isMcpToken } from '$lib/mcp/token';
import { mcpResource } from '$lib/mcp/oauth';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';
import { getMcpSessionManager } from './sessionManager';
import { handleJsonRpcMessage } from './protocol';

const MAX_REQUEST_BYTES = 1024 * 1024;
const RESPONSE_HEADERS = { 'Cache-Control': 'no-store' };

type McpNamespace = {
	idFromName: (name: string) => unknown;
	get: (id: unknown) => { fetch: (request: Request) => Promise<Response> };
};

function namespace(platform: unknown): McpNamespace | undefined {
	return (platform as { env?: { ACCOUNT_MCP_SESSION?: McpNamespace } } | undefined)?.env
		?.ACCOUNT_MCP_SESSION;
}

function bearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization');
	const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
	if (!match) return null;
	const token = match[1];
	return isMcpToken(token) ? token : null;
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
	const token = bearerToken(request);
	if (!token) return unauthorized(request);

	const proxied = await proxyToDurableObject(request, platform, token);
	if (proxied) return withAuthorizationChallenge(request, proxied);

	let session;
	try {
		session = await getMcpSessionManager().getSessionFromToken(token);
	} catch {
		return unauthorized(request, 'Invalid or revoked MCP token');
	}

	let interval: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			const send = (event: string, data: string) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				} catch {
					// The abort handler performs cleanup.
				}
			};
			send('endpoint', `${url.origin}/api/mcp/messages`);
			interval = setInterval(() => send('ping', '{}'), 15_000);
			unsubscribe = session.addSseListener((event, data) => {
				send(event, typeof data === 'string' ? data : JSON.stringify(data));
				if (event === 'close') {
					if (interval) clearInterval(interval);
					unsubscribe?.();
					controller.close();
				}
			});
			request.signal.addEventListener(
				'abort',
				() => {
					if (interval) clearInterval(interval);
					unsubscribe?.();
					try {
						controller.close();
					} catch {
						// The stream may already be closed.
					}
				},
				{ once: true }
			);
		},
		cancel() {
			if (interval) clearInterval(interval);
			unsubscribe?.();
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		}
	});
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
	const token = bearerToken(request);
	if (!token) return unauthorized(request);

	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength > MAX_REQUEST_BYTES) {
		return json(
			{ error: 'MCP request body is too large' },
			{ status: 413, headers: RESPONSE_HEADERS }
		);
	}

	const proxied = await proxyToDurableObject(request, platform, token);
	if (proxied) return withAuthorizationChallenge(request, proxied);

	let session;
	try {
		session = await getMcpSessionManager().getSessionFromToken(token);
	} catch {
		return unauthorized(request, 'Invalid or revoked MCP token');
	}

	let rawBody: string;
	try {
		rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).length > MAX_REQUEST_BYTES) {
			return json(
				{ error: 'MCP request body is too large' },
				{ status: 413, headers: RESPONSE_HEADERS }
			);
		}
	} catch {
		return json(
			{ error: 'Could not read request body' },
			{ status: 400, headers: RESPONSE_HEADERS }
		);
	}

	let body: unknown;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return json(
			{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
			{ status: 400, headers: RESPONSE_HEADERS }
		);
	}

	const response = await handleJsonRpcMessage(session, body);
	const legacySseMessage = url.pathname.endsWith('/messages');
	if (response === null) {
		return new Response(null, { status: 202, headers: RESPONSE_HEADERS });
	}

	if (legacySseMessage) {
		if (Array.isArray(response)) {
			for (const item of response) session.broadcast('message', item);
		} else {
			session.broadcast('message', response);
		}
		return new Response(null, { status: 202, headers: RESPONSE_HEADERS });
	}
	return json(response, { headers: RESPONSE_HEADERS });
};
