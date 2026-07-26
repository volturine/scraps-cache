import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { syncSecretHash } from '$lib/server/syncAuth';
import { readJsonBody } from '$lib/server/request';

export const POST: RequestHandler = async ({ request }) => {
	let body: { accountId?: unknown; authSecret?: unknown };
	try {
		body = await readJsonBody(request, 16_384) as typeof body;
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}
	if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.accountId)) {
		return json({ error: 'Invalid account identity' }, { status: 400 });
	}
	if (typeof body.authSecret !== 'string' || body.authSecret.length < 32 || body.authSecret.length > 256) {
		return json({ error: 'Invalid account credential' }, { status: 400 });
	}
	try {
		const created = getSyncStore().createAccount(body.accountId, syncSecretHash(body.authSecret));
		if (!created) return json({ error: 'This sync account already exists on this device.' }, { status: 409 });
		return json({ accountId: body.accountId });
	} catch (err) {
		console.error('[sync] register failed:', err);
		return json({ error: 'Sync storage is temporarily unavailable' }, { status: 503 });
	}
};
