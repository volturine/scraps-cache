import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	adminAccountId,
	authorizeAdminApi,
	disableManagedAccountMcp,
	enableManagedAccountMcp,
	managedAccountResponse,
	readAdminAccountBody
} from '$lib/server/adminHttp';

async function accountId(request: Request): Promise<string | null> {
	return adminAccountId(await readAdminAccountBody(request));
}

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const account = await accountId(request);
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	return managedAccountResponse(account);
};

export const PUT: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const account = await accountId(request);
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	return enableManagedAccountMcp(account);
};

export const DELETE: RequestHandler = async ({ request, getClientAddress, platform }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const account = await accountId(request);
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	return disableManagedAccountMcp(account, platform);
};
