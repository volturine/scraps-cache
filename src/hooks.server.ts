import type { Handle } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { backupManager } from '$lib/server/backupManager';
import { recordHttpRequest } from '$lib/server/metrics';
import { closeSyncStore } from '$lib/server/syncStore';

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	['referrer-policy', 'no-referrer'],
	['x-content-type-options', 'nosniff'],
	['x-frame-options', 'DENY'],
	['permissions-policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()']
];

export const handle: Handle = async ({ event, resolve }) => {
	backupManager.start();
	const startedAt = performance.now();
	const suppliedRequestId = event.request.headers.get('x-request-id') ?? '';
	const requestId = /^[A-Za-z0-9._-]{1,128}$/.test(suppliedRequestId)
		? suppliedRequestId
		: randomUUID();
	const response = await resolve(event);
	for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
	response.headers.set('x-request-id', requestId);
	const durationMs = performance.now() - startedAt;
	recordHttpRequest(event.url.pathname, response.status, durationMs);
	if (event.url.pathname.startsWith('/api/') && response.status >= 400) {
		console.info(JSON.stringify({
			level: 'info',
			event: 'http_request',
			requestId,
			path: event.url.pathname,
			status: response.status,
			durationMs: Math.round(durationMs)
		}));
	}
	return response;
};

process.on('sveltekit:shutdown', async () => {
	backupManager.stop();
	closeSyncStore();
});
