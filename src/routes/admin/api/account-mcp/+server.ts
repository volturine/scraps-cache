import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { disableAccountMcp, enableAccountMcp } from '$lib/server/adminAccounts';
import { ACCOUNT_ID_RE } from '$lib/server/pushWakes';
import { readJsonBody } from '$lib/server/request';

const NO_STORE = { 'cache-control': 'no-store' };

async function accountId(request: Request): Promise<string | null> {
	try {
		const body = (await readJsonBody(request, 1_024)) as { accountId?: unknown };
		return typeof body.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
			? body.accountId
			: null;
	} catch {
		return null;
	}
}

export const PUT: RequestHandler = async ({ request }) => {
	const account = await accountId(request);
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	const result = await enableAccountMcp(account);
	return result
		? json(result, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
};

export const DELETE: RequestHandler = async ({ request, platform }) => {
	const account = await accountId(request);
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	const result = await disableAccountMcp(account, platform);
	return result
		? json(result, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
};
