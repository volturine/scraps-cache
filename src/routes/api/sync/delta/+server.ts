import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore, SyncQuotaExceededError } from '$lib/server/syncStore';
import { getSyncAuth } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';
import {
	clientAddress,
	enterSyncRequest,
	getPublicApiLimiter,
	rateLimitResponse
} from '$lib/server/rateLimit';
import { env } from '$env/dynamic/private';
import { recordSqliteError, recordSyncBatch } from '$lib/server/metrics';

// Clients re-encode attachments to ~4 MiB before upload (imageOptimize.ts);
// 16 MB leaves ample headroom for base64 expansion and encoding variance.
const MAX_ENVELOPE_BYTES = 16_000_000;
const MAX_REQUEST_BYTES = MAX_ENVELOPE_BYTES + 1_000_000;
const MAX_ENVELOPES_PER_REQUEST = 2_000;
const DEFAULT_DOWNLOAD_LIMIT = 12;
type OpaqueEnvelope = { id: string; ciphertext: string; slot: string; expectedId: string | null };
type OpaqueDelete = { id: string; slot: string };

function isOpaqueEnvelope(value: unknown): value is OpaqueEnvelope {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as OpaqueEnvelope).id === 'string' &&
		typeof (value as OpaqueEnvelope).ciphertext === 'string' &&
		typeof (value as OpaqueEnvelope).slot === 'string' &&
		((value as OpaqueEnvelope).expectedId === null ||
			(typeof (value as OpaqueEnvelope).expectedId === 'string' &&
				/^[A-Za-z0-9_-]+$/.test((value as OpaqueEnvelope).expectedId!) &&
				(value as OpaqueEnvelope).expectedId!.length <= 128)) &&
		(value as OpaqueEnvelope).id.length <= 128 &&
		(value as OpaqueEnvelope).ciphertext.length <= MAX_ENVELOPE_BYTES &&
		/^[A-Za-z0-9_-]+$/.test((value as OpaqueEnvelope).id) &&
		/^[a-f0-9]{64}$/.test((value as OpaqueEnvelope).slot) &&
		/^[A-Za-z0-9_-]+$/.test((value as OpaqueEnvelope).ciphertext)
	);
}

function isOpaqueDelete(value: unknown): value is OpaqueDelete {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as OpaqueDelete).id === 'string' &&
		typeof (value as OpaqueDelete).slot === 'string' &&
		(value as OpaqueDelete).id.length <= 128 &&
		/^[A-Za-z0-9_-]+$/.test((value as OpaqueDelete).id) &&
		/^[a-f0-9]{64}$/.test((value as OpaqueDelete).slot)
	);
}

/** Current-state opaque relay: each keyed slot holds one latest ciphertext only. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const addressLimit = await getPublicApiLimiter().check(
		`sync-ip:${clientAddress(getClientAddress)}`,
		{
			capacity: 120,
			refillWindowMs: 60_000
		}
	);
	if (!addressLimit.allowed) return rateLimitResponse(addressLimit);
	const release = enterSyncRequest(
		Math.max(1, Number(env.SCRAPSCACHE_SYNC_MAX_CONCURRENT_REQUESTS) || 8)
	);
	if (!release) {
		return json({ error: 'Sync server is busy' }, { status: 503, headers: { 'retry-after': '2' } });
	}
	try {
		const accountId = await getSyncAuth().authenticateSyncRequest(request);
		if (!accountId) return json({ error: 'Invalid sync session' }, { status: 401 });
		let body: {
			cursor?: unknown;
			envelopes?: unknown;
			deleteSlots?: unknown;
			limit?: unknown;
		};
		try {
			body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as typeof body;
		} catch {
			return json({ error: 'Invalid JSON body' }, { status: 400 });
		}
		const cursor =
			typeof body.cursor === 'number' && Number.isInteger(body.cursor) && body.cursor >= 0
				? body.cursor
				: 0;
		const envelopes = body.envelopes == null ? [] : body.envelopes;
		if (
			!Array.isArray(envelopes) ||
			envelopes.length > MAX_ENVELOPES_PER_REQUEST ||
			!envelopes.every(isOpaqueEnvelope)
		) {
			return json({ error: 'Invalid encrypted envelope batch' }, { status: 400 });
		}
		const deleteSlots = body.deleteSlots == null ? [] : body.deleteSlots;
		if (
			!Array.isArray(deleteSlots) ||
			deleteSlots.length > MAX_ENVELOPES_PER_REQUEST ||
			!deleteSlots.every(isOpaqueDelete)
		) {
			return json({ error: 'Invalid encrypted deletion batch' }, { status: 400 });
		}
		const limit =
			typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0
				? Math.min(body.limit, 50)
				: DEFAULT_DOWNLOAD_LIMIT;
		recordSyncBatch(envelopes.length, deleteSlots.length);
		try {
			const store = getSyncStore();
			const accountLimit = await getPublicApiLimiter().check(`sync-account:${accountId}`, {
				capacity: 60,
				refillWindowMs: 60_000
			});
			if (!accountLimit.allowed) return rateLimitResponse(accountLimit);
			return json(await store.sync(accountId, cursor, envelopes, deleteSlots, limit));
		} catch (error) {
			recordSqliteError(error);
			if (error instanceof SyncQuotaExceededError) {
				return json({ error: 'Sync account storage quota exceeded' }, { status: 507 });
			}
			console.error('[sync] current-state relay failed:', error);
			return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
		}
	} finally {
		release();
	}
};
