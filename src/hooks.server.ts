import type { Handle } from '@sveltejs/kit';
import { recordHttpRequest } from '$lib/server/metrics';
import { isAdminAuthorized } from '$lib/server/adminAuth';
import { authenticateCloudflareAdmin } from '$lib/server/cloudflareAccess';
import { isOAuthBrowserOrigin } from '$lib/mcp/oauth';
import { OAUTH_TOKEN_PATH } from '$lib/server/mcp/oauthCsrf';

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	['referrer-policy', 'no-referrer'],
	['strict-transport-security', 'max-age=31536000'],
	['x-content-type-options', 'nosniff'],
	['x-frame-options', 'DENY'],
	['permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()']
];
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
	// Token exchange is form-encoded; originless clients and OAUTH_BROWSER_ORIGINS
	// are allowed on that path only.
	return url.pathname !== OAUTH_TOKEN_PATH || (origin !== null && !isOAuthBrowserOrigin(origin));
}

export function isAdminApiPath(pathname: string): boolean {
	return pathname === '/admin/api' || pathname.startsWith('/admin/api/');
}

export async function rejectsAdminRequest(request: Request, pathname: string): Promise<boolean> {
	if (pathname !== '/admin' && !pathname.startsWith('/admin/')) return false;
	if (await authenticateCloudflareAdmin(request)) return false;
	return !isAdminApiPath(pathname) || !isAdminAuthorized(request);
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
	} else if (await rejectsAdminRequest(event.request, event.url.pathname)) {
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
