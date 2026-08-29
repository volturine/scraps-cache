import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { getSyncStore } from '$lib/server/syncStore';
import { ACCOUNT_ID_RE } from '$lib/server/pushWakes';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';
import { readJsonBody } from '$lib/server/request';

const MAX_REQUEST_BYTES = 1_024;
type QuotaBody = { accountId?: unknown; maxBytes?: unknown };
type AccountQuotaBody = { accountId: string; maxBytes?: unknown };

function authorize(request: Request, getClientAddress: () => string): Response | null {
	const limit = checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	return null;
}

async function readAccount(request: Request): Promise<AccountQuotaBody | null> {
	try {
		const body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as QuotaBody;
		return typeof body.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
			? { accountId: body.accountId, maxBytes: body.maxBytes }
			: null;
	} catch {
		return null;
	}
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = authorize(request, getClientAddress);
	if (rejected) return rejected;
	const body = await readAccount(request);
	if (!body) return json({ error: 'Invalid request body' }, { status: 400 });
	const quota = getSyncStore().getAccountByteQuota(body.accountId);
	return quota
		? json(quota, { headers: { 'cache-control': 'no-store' } })
		: json({ error: 'Sync account not found' }, { status: 404 });
};

export const PUT: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = authorize(request, getClientAddress);
	if (rejected) return rejected;
	const body = await readAccount(request);
	if (!body || !Number.isSafeInteger(body.maxBytes) || Number(body.maxBytes) <= 0) {
		return json(
			{ error: 'accountId and a positive safe-integer maxBytes are required' },
			{
				status: 400
			}
		);
	}
	const store = getSyncStore();
	if (!store.setAccountByteQuota(body.accountId, Number(body.maxBytes))) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return json(store.getAccountByteQuota(body.accountId), {
		headers: { 'cache-control': 'no-store' }
	});
};

export const DELETE: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = authorize(request, getClientAddress);
	if (rejected) return rejected;
	const body = await readAccount(request);
	if (!body) return json({ error: 'Invalid request body' }, { status: 400 });
	const store = getSyncStore();
	if (!store.clearAccountByteQuota(body.accountId)) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return json(store.getAccountByteQuota(body.accountId), {
		headers: { 'cache-control': 'no-store' }
	});
};
