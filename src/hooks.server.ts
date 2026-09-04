import type { Handle } from '@sveltejs/kit';
import { recordHttpRequest } from '$lib/server/metrics';
import { authenticateCloudflareAdmin } from '$lib/server/cloudflareAccess';

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	['referrer-policy', 'no-referrer'],
	['strict-transport-security', 'max-age=31536000'],
	['x-content-type-options', 'nosniff'],
	['x-frame-options', 'DENY'],
	['permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()']
];
const GROK_ORIGIN = 'https://grok.com';
const OAUTH_TOKEN_PATH = '/api/mcp/oauth/token';
const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

export function rejectsCrossSiteForm(request: Request, url: URL): boolean {
	if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return false;
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (!contentType || !FORM_CONTENT_TYPES.has(contentType)) return false;

	const origin = request.headers.get('origin');
	if (origin === url.origin) return false;
	return url.pathname !== OAUTH_TOKEN_PATH || (origin !== null && origin !== GROK_ORIGIN);
}

export const handle: Handle = async ({ event, resolve }) => {
	const startedAt = performance.now();
	const suppliedRequestId = event.request.headers.get('x-request-id') ?? '';
	const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(suppliedRequestId)
		? suppliedRequestId
		: crypto.randomUUID();
	let response: Response;
	if (rejectsCrossSiteForm(event.request, event.url)) {
		response = new Response('Cross-site form submissions are forbidden', { status: 403 });
	} else if (
		(event.url.pathname === '/admin' || event.url.pathname.startsWith('/admin/')) &&
		!(await authenticateCloudflareAdmin(event.request))
	) {
		response = new Response('Not found\n', {
			status: 404,
			headers: { 'cache-control': 'no-store' }
		});
	} else {
		response = await resolve(event);
	}
	let finalResponse = response;
	try {
		for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
		response.headers.set('x-request-id', requestId);
	} catch {
		// Response headers may be immutable (e.g. from Durable Objects or upstream fetch)
		const newHeaders = new Headers(response.headers);
		for (const [name, value] of SECURITY_HEADERS) newHeaders.set(name, value);
		newHeaders.set('x-request-id', requestId);
		finalResponse = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: newHeaders
		});
	}
	const durationMs = performance.now() - startedAt;
	recordHttpRequest(event.url.pathname, finalResponse.status, durationMs);
	if (event.url.pathname.startsWith('/api/') && finalResponse.status >= 400) {
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'http_request',
				requestId,
				path: event.url.pathname,
				status: finalResponse.status,
				durationMs: Math.round(durationMs)
			})
		);
	}
	return finalResponse;
};
