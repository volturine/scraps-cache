export const OAUTH_TOKEN_PATH = '/api/mcp/oauth/token';

const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain'
]);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const NODE_RESPOND_MARKER = 'const response = await server.respond(request,';

/** SvelteKit CSRF rejects missing Origin before hooks. Stamp same-origin only on the token route. */
export function stampOriginlessOAuthToken(request: Request): Request {
	if (!MUTATING.has(request.method)) return request;
	const url = new URL(request.url);
	if (url.pathname !== OAUTH_TOKEN_PATH) return request;
	if (request.headers.get('origin') !== null) return request;
	const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (!contentType || !FORM_CONTENT_TYPES.has(contentType)) return request;
	const headers = new Headers(request.headers);
	headers.set('origin', url.origin);
	return new Request(request, { headers });
}

export function withOriginlessOAuthTokenStamp(handlerSource: string): string {
	if (!handlerSource.includes(NODE_RESPOND_MARKER)) {
		throw new Error(
			'adapter-node handler.js no longer calls server.respond(request); cannot skip CSRF on the OAuth token route'
		);
	}
	if (handlerSource.includes('stampOriginlessOAuthToken')) return handlerSource;
	return `import { stampOriginlessOAuthToken } from './oauthCsrf.ts';\n${handlerSource.replace(
		NODE_RESPOND_MARKER,
		`request = stampOriginlessOAuthToken(request);\n\t${NODE_RESPOND_MARKER}`
	)}`;
}
