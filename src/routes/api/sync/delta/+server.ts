import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore, SyncQuotaExceededError } from '$lib/server/syncStore';
import { sameSyncSecret } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';

const MAX_ENVELOPE_BYTES = 100_000_000;
const MAX_REQUEST_BYTES = MAX_ENVELOPE_BYTES + 1_000_000;
const MAX_ENVELOPES_PER_REQUEST = 2_000;
const DEFAULT_DOWNLOAD_LIMIT = 12;
type OpaqueEnvelope = { id: string; ciphertext: string; slot: string };

function isOpaqueEnvelope(value: unknown): value is OpaqueEnvelope {
	return !!value && typeof value === 'object'
		&& typeof (value as OpaqueEnvelope).id === 'string'
		&& typeof (value as OpaqueEnvelope).ciphertext === 'string'
		&& typeof (value as OpaqueEnvelope).slot === 'string'
		&& (value as OpaqueEnvelope).id.length <= 128
		&& (value as OpaqueEnvelope).ciphertext.length <= MAX_ENVELOPE_BYTES
		&& /^[A-Za-z0-9_-]+$/.test((value as OpaqueEnvelope).id)
		&& /^[a-f0-9]{64}$/.test((value as OpaqueEnvelope).slot)
		&& /^[A-Za-z0-9_-]+$/.test((value as OpaqueEnvelope).ciphertext);
}

/** Current-state opaque relay: each keyed slot holds one latest ciphertext only. */
export const POST: RequestHandler = async ({ request }) => {
	let body: { accountId?: unknown; authSecret?: unknown; cursor?: unknown; envelopes?: unknown; limit?: unknown };
	try { body = await readJsonBody(request, MAX_REQUEST_BYTES) as typeof body; } catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }
	if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId)
		|| typeof body.authSecret !== 'string' || body.authSecret.length < 32 || body.authSecret.length > 256) {
		return json({ error: 'Sync account credentials are required' }, { status: 400 });
	}
	const cursor = typeof body.cursor === 'number' && Number.isInteger(body.cursor) && body.cursor >= 0 ? body.cursor : 0;
	const envelopes = body.envelopes == null ? [] : body.envelopes;
	if (!Array.isArray(envelopes) || envelopes.length > MAX_ENVELOPES_PER_REQUEST || !envelopes.every(isOpaqueEnvelope)) return json({ error: 'Invalid encrypted envelope batch' }, { status: 400 });
	const limit = typeof body.limit === 'number' && Number.isInteger(body.limit) && body.limit > 0 ? Math.min(body.limit, 50) : DEFAULT_DOWNLOAD_LIMIT;
	try {
		const store = getSyncStore();
		const credentialHash = store.getCredentialHash(body.accountId);
		if (!credentialHash || !sameSyncSecret(credentialHash, body.authSecret)) {
			return json({ error: 'Invalid sync account credentials' }, { status: 404 });
		}
		return json(store.sync(body.accountId, cursor, envelopes, limit));
	} catch (error) {
		if (error instanceof SyncQuotaExceededError) {
			return json({ error: 'Sync account storage quota exceeded' }, { status: 507 });
		}
		console.error('[sync] current-state relay failed:', error);
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
