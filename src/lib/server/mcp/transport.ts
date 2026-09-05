import { isMcpToken } from '$lib/mcp/token';
import type { McpSession } from './engine';
import { handleJsonRpcMessage } from './protocol';

export const MCP_MAX_REQUEST_BYTES = 1024 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };

export function mcpBearerToken(request: Request): string | null {
	const authorization = request.headers.get('authorization');
	const match = authorization?.match(/^Bearer\s+(\S+)\s*$/i);
	if (!match) return null;
	return isMcpToken(match[1]) ? match[1] : null;
}

export function isLegacySsePath(pathname: string): boolean {
	return pathname.endsWith('/sse');
}

export function isLegacyMessagesPath(pathname: string): boolean {
	return pathname.endsWith('/messages');
}

export function mcpRequestTooLarge(request: Request): Response | null {
	const contentLength = Number(request.headers.get('content-length') ?? 0);
	if (contentLength <= MCP_MAX_REQUEST_BYTES) return null;
	return Response.json(
		{ error: 'MCP request body is too large' },
		{ status: 413, headers: NO_STORE }
	);
}

export function mcpSseResponse(request: Request, session: McpSession, url: URL): Response {
	const announceEndpoint = isLegacySsePath(url.pathname);
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
			if (announceEndpoint) send('endpoint', `${url.origin}/api/mcp/messages`);
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
}

export async function readMcpJsonBody(
	request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
	const tooLarge = mcpRequestTooLarge(request);
	if (tooLarge) return { ok: false, response: tooLarge };
	let rawBody: string;
	try {
		rawBody = await request.text();
		if (new TextEncoder().encode(rawBody).length > MCP_MAX_REQUEST_BYTES) {
			return {
				ok: false,
				response: Response.json(
					{ error: 'MCP request body is too large' },
					{ status: 413, headers: NO_STORE }
				)
			};
		}
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ error: 'Could not read request body' },
				{ status: 400, headers: NO_STORE }
			)
		};
	}
	try {
		return { ok: true, body: JSON.parse(rawBody) };
	} catch {
		return {
			ok: false,
			response: Response.json(
				{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
				{ status: 400, headers: NO_STORE }
			)
		};
	}
}

export async function mcpJsonRpcResponse(
	session: McpSession,
	body: unknown,
	pathname: string
): Promise<Response> {
	const response = await handleJsonRpcMessage(session, body);
	if (response === null) return new Response(null, { status: 202, headers: NO_STORE });
	if (isLegacyMessagesPath(pathname)) {
		if (Array.isArray(response)) {
			for (const item of response) session.broadcast('message', item);
		} else {
			session.broadcast('message', response);
		}
		return new Response(null, { status: 202, headers: NO_STORE });
	}
	return Response.json(response, { headers: NO_STORE });
}
