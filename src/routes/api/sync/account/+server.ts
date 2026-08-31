import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { authenticateSyncRequest, revokeSyncSessions } from '$lib/server/syncAuth';
import { clientAddress, publicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const DELETE: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = publicApiLimiter.check(`delete-account:${clientAddress(getClientAddress)}`, {
		capacity: 5,
		refillWindowMs: 60 * 60 * 1000
	});
	if (!limited.allowed) return rateLimitResponse(limited);
	const accountId = authenticateSyncRequest(request);
	if (!accountId) return json({ error: 'Account could not be deleted' }, { status: 401 });
	try {
		const store = getSyncStore();
		store.deleteAccount(accountId);
		revokeSyncSessions(accountId);
		return new Response(null, { status: 204 });
	} catch (error) {
		console.error('[sync] account deletion failed');
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
