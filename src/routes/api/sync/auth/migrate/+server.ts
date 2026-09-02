import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	getSyncAuth,
	isLegacySyncCredential,
	sameLegacySyncSecret,
	verifySyncMigration
} from '$lib/server/syncAuth';
import { getSyncStore } from '$lib/server/syncStore';
import { readJsonBody } from '$lib/server/request';
import { clientAddress, getPublicApiLimiter, rateLimitResponse } from '$lib/server/rateLimit';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const limited = await getPublicApiLimiter().check(
		`auth-migrate-ip:${clientAddress(getClientAddress)}`,
		{
			capacity: 120,
			refillWindowMs: 60 * 60 * 1000
		}
	);
	if (!limited.allowed) return rateLimitResponse(limited);
	let body: {
		accountId?: unknown;
		authSecret?: unknown;
		authPublicKey?: unknown;
		signature?: unknown;
	};
	try {
		body = (await readJsonBody(request, 8_192)) as typeof body;
	} catch {
		return json({ error: 'Authentication upgrade failed' }, { status: 401 });
	}
	if (
		typeof body.accountId !== 'string' ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId) ||
		typeof body.authSecret !== 'string' ||
		body.authSecret.length < 32 ||
		body.authSecret.length > 256 ||
		typeof body.authPublicKey !== 'string' ||
		typeof body.signature !== 'string' ||
		!verifySyncMigration(body.accountId, body.authPublicKey, body.signature)
	) {
		return json({ error: 'Authentication upgrade failed' }, { status: 401 });
	}
	const accountLimited = await getPublicApiLimiter().check(
		`auth-migrate-account:${body.accountId}`,
		{
			capacity: 5,
			refillWindowMs: 60 * 60 * 1000
		}
	);
	if (!accountLimited.allowed) return rateLimitResponse(accountLimited);
	const store = getSyncStore();
	const credential = await store.getAuthCredential(body.accountId);
	if (
		!credential ||
		!isLegacySyncCredential(credential) ||
		!(await sameLegacySyncSecret(credential, body.authSecret)) ||
		!(await store.replaceAuthCredential(body.accountId, credential, body.authPublicKey))
	) {
		return json({ error: 'Authentication upgrade failed' }, { status: 401 });
	}
	return json(await getSyncAuth().createSyncSession(body.accountId));
};
