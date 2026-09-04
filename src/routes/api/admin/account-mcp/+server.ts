import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { getManagedAccount, enableAccountMcp, disableAccountMcp } from '$lib/server/adminAccounts';
import { ACCOUNT_ID_RE } from '$lib/server/pushWakes';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';
import { readJsonBody } from '$lib/server/request';

const MAX_REQUEST_BYTES = 1_024;
const NO_STORE = { 'cache-control': 'no-store' };

async function authorize(
	request: Request,
	getClientAddress: () => string
): Promise<Response | null> {
	const limit = await checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	return isAdminAuthorized(request) ? null : unauthorizedAdminResponse();
}

async function readAccountId(request: Request): Promise<string | null> {
	try {
		const body = (await readJsonBody(request, MAX_REQUEST_BYTES)) as { accountId?: unknown };
		return typeof body.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
			? body.accountId
			: null;
	} catch {
		return null;
	}
}

async function accountIdOrError(request: Request): Promise<string | Response> {
	const accountId = await readAccountId(request);
	return accountId ?? json({ error: 'Invalid request body' }, { status: 400 });
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorize(request, getClientAddress);
	if (rejected) return rejected;
	const accountId = await accountIdOrError(request);
	if (accountId instanceof Response) return accountId;
	const account = await getManagedAccount(accountId);
	return account
		? json(account.mcp, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
};

export const PUT: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorize(request, getClientAddress);
	if (rejected) return rejected;
	const accountId = await accountIdOrError(request);
	if (accountId instanceof Response) return accountId;
	const account = await enableAccountMcp(accountId);
	return account
		? json(account.mcp, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
};

export const DELETE: RequestHandler = async ({ request, getClientAddress, platform }) => {
	const rejected = await authorize(request, getClientAddress);
	if (rejected) return rejected;
	const accountId = await accountIdOrError(request);
	if (accountId instanceof Response) return accountId;
	const account = await disableAccountMcp(accountId, platform);
	return account
		? json(account.mcp, { headers: NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
};
