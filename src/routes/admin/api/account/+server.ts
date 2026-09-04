import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getManagedAccount } from '$lib/server/adminAccounts';
import { getSyncStore } from '$lib/server/syncStore';
import { ACCOUNT_ID_RE } from '$lib/server/pushWakes';
import { InvalidRequestBody, readJsonBody } from '$lib/server/request';

const MAX_REQUEST_BYTES = 1_024;
const NO_STORE = { 'cache-control': 'no-store' };
type Body = { accountId?: unknown; maxBytes?: unknown };

async function readBody(request: Request): Promise<Body | null> {
	try {
		return (await readJsonBody(request, MAX_REQUEST_BYTES)) as Body;
	} catch (error) {
		if (error instanceof InvalidRequestBody) return null;
		throw error;
	}
}

function accountId(body: Body | null): string | null {
	return typeof body?.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
		? body.accountId
		: null;
}

async function responseFor(account: string): Promise<Response> {
	const result = await getManagedAccount(account);
	return result
		? json(result, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
}

export const POST: RequestHandler = async ({ request }) => {
	const account = accountId(await readBody(request));
	return account ? responseFor(account) : json({ error: 'Invalid request body' }, { status: 400 });
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await readBody(request);
	const account = accountId(body);
	if (!account || !Number.isSafeInteger(body?.maxBytes) || Number(body?.maxBytes) <= 0) {
		return json({ error: 'A valid account and positive byte limit are required' }, { status: 400 });
	}
	if (!(await getSyncStore().setAccountByteQuota(account, Number(body?.maxBytes)))) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return responseFor(account);
};

export const DELETE: RequestHandler = async ({ request }) => {
	const account = accountId(await readBody(request));
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	if (!(await getSyncStore().clearAccountByteQuota(account))) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return responseFor(account);
};
