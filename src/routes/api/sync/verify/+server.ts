import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { sameSyncSecret } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';
import {
	clientAddress,
	enterSyncRequest,
	publicApiLimiter,
	rateLimitResponse
} from '$lib/server/rateLimit';
import { env } from '$env/dynamic/private';
import { recordSqliteError } from '$lib/server/metrics';

const MAX_REQUEST_BYTES = 4_000;

type VerifyBody = { accountId?: unknown; authSecret?: unknown };

/**
 * Integrity handshake: returns every slot the account holds so the owner can
 * diff against what it expects. Slots are keyed hashes derived from the sync
 * key, so the response is opaque to anyone without it.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = publicApiLimiter.check(`sync-ip:${clientAddress(getClientAddress)}`, {
		capacity: 120,
		refillWindowMs: 60_000
	});
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);
	const release = enterSyncRequest(
		Math.max(1, Number(env.SCRAPS_CACHE_SYNC_MAX_CONCURRENT_REQUESTS) || 8)
	);
	if (!release) {
		return json({ error: 'Sync server is busy' }, { status: 503, headers: { 'retry-after': '2' } });
	}
	try {
		let body: VerifyBody;
		try {
			body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as VerifyBody;
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}
		if (
			typeof body.accountId !== 'string' ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId) ||
			typeof body.authSecret !== 'string' ||
			body.authSecret.length < 32 ||
			body.authSecret.length > 256
		) {
			return json({ error: 'Sync account credentials are required' }, { status: 400 });
		}
		try {
			const store = getSyncStore();
			const credentialHash = store.getCredentialHash(body.accountId);
			if (!credentialHash || !(await sameSyncSecret(credentialHash, body.authSecret))) {
				return json({ error: 'Invalid sync account credentials' }, { status: 404 });
			}
			const accountLimit = publicApiLimiter.check(`sync-account:${body.accountId}`, {
				capacity: 60,
				refillWindowMs: 60_000
			});
			if (!accountLimit.allowed) return rateLimitResponse(accountLimit);
			return json(store.listAccountSlotsWithTags(body.accountId));
		} catch (error) {
			recordSqliteError(error);
			console.error('[sync] integrity verification failed:', error);
			return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
		}
	} finally {
		release();
	}
};
