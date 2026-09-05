import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import {
	adminAccountId,
	authorizeAdminApi,
	clearManagedAccountQuota,
	managedAccountResponse,
	readAdminAccountBody,
	setManagedAccountQuota
} from '$lib/server/adminHttp';

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const account = adminAccountId(await readAdminAccountBody(request));
	return account
		? managedAccountResponse(account)
		: json({ error: 'Invalid request body' }, { status: 400 });
};

export const PUT: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const body = await readAdminAccountBody(request);
	const account = adminAccountId(body);
	if (!account) {
		return json({ error: 'A valid account and positive byte limit are required' }, { status: 400 });
	}
	return setManagedAccountQuota(account, body?.maxBytes);
};

export const DELETE: RequestHandler = async ({ request, getClientAddress }) => {
	const rejected = await authorizeAdminApi(request, getClientAddress);
	if (rejected) return rejected;
	const account = adminAccountId(await readAdminAccountBody(request));
	if (!account) return json({ error: 'Invalid request body' }, { status: 400 });
	return clearManagedAccountQuota(account);
};
