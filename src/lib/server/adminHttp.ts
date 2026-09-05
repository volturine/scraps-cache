import { json } from '@sveltejs/kit';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { disableAccountMcp, enableAccountMcp, getManagedAccount } from '$lib/server/adminAccounts';
import { authenticateCloudflareAdmin } from '$lib/server/cloudflareAccess';
import {
	bytesToGigabytes,
	parseRetentionInactiveDays,
	staleBeforeMs
} from '$lib/server/operatorConfig';
import { getOperatorSnapshot } from '$lib/server/operatorMonitor';
import { renderMetrics } from '$lib/server/metrics';
import { ACCOUNT_ID_RE } from '$lib/server/pushWakes';
import { checkAdminApiLimit, rateLimitResponse } from '$lib/server/rateLimit';
import { InvalidRequestBody, readJsonBody } from '$lib/server/request';
import { getRetentionStatus, runRetentionSweep } from '$lib/server/retentionSweep';
import { getSyncStore } from '$lib/server/syncStore';

export const ADMIN_NO_STORE = { 'cache-control': 'no-store' };

type AccountBody = { accountId?: unknown; maxBytes?: unknown };

export async function rejectBearerAdmin(
	request: Request,
	getClientAddress: () => string
): Promise<Response | null> {
	const limit = await checkAdminApiLimit(getClientAddress);
	if (!limit.allowed) return rateLimitResponse(limit);
	return isAdminAuthorized(request) ? null : unauthorizedAdminResponse();
}

export async function authorizeAdminApi(
	request: Request,
	getClientAddress: () => string
): Promise<Response | null> {
	if (await authenticateCloudflareAdmin(request)) return null;
	return rejectBearerAdmin(request, getClientAddress);
}

export async function readAdminAccountBody(request: Request): Promise<AccountBody | null> {
	try {
		return (await readJsonBody(request, 1_024)) as AccountBody;
	} catch (error) {
		if (error instanceof InvalidRequestBody) return null;
		throw error;
	}
}

export function adminAccountId(body: AccountBody | null): string | null {
	return typeof body?.accountId === 'string' && ACCOUNT_ID_RE.test(body.accountId)
		? body.accountId
		: null;
}

export async function adminStatusResponse(): Promise<Response> {
	return json(await getOperatorSnapshot(), { headers: ADMIN_NO_STORE });
}

export async function adminMetricsResponse(): Promise<Response> {
	const now = Date.now();
	const usage = await getSyncStore().operatorUsage({
		now,
		staleBefore: staleBeforeMs(parseRetentionInactiveDays(), now)
	});
	return new Response(
		renderMetrics(
			{
				...usage,
				gigabytes: bytesToGigabytes(usage.storageBytes)
			},
			await getRetentionStatus()
		),
		{
			headers: {
				'content-type': 'text/plain; version=0.0.4; charset=utf-8',
				...ADMIN_NO_STORE
			}
		}
	);
}

export async function managedAccountResponse(accountId: string): Promise<Response> {
	const account = await getManagedAccount(accountId);
	return account
		? json(account, { headers: ADMIN_NO_STORE })
		: json({ error: 'Sync account not found' }, { status: 404 });
}

export async function setManagedAccountQuota(
	accountId: string,
	maxBytes: unknown
): Promise<Response> {
	if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) <= 0) {
		return json({ error: 'A valid account and positive byte limit are required' }, { status: 400 });
	}
	if (!(await getSyncStore().setAccountByteQuota(accountId, Number(maxBytes)))) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return managedAccountResponse(accountId);
}

export async function clearManagedAccountQuota(accountId: string): Promise<Response> {
	if (!(await getSyncStore().clearAccountByteQuota(accountId))) {
		return json({ error: 'Sync account not found' }, { status: 404 });
	}
	return managedAccountResponse(accountId);
}

function missingAccount(): Response {
	return json({ error: 'Sync account not found' }, { status: 404 });
}

export async function enableManagedAccountMcp(accountId: string): Promise<Response> {
	const account = await enableAccountMcp(accountId);
	return account ? json(account, { headers: ADMIN_NO_STORE }) : missingAccount();
}

export async function disableManagedAccountMcp(
	accountId: string,
	platform: unknown
): Promise<Response> {
	const account = await disableAccountMcp(accountId, platform);
	return account ? json(account, { headers: ADMIN_NO_STORE }) : missingAccount();
}

export async function retentionSweepResponse(): Promise<Response> {
	try {
		return json(await runRetentionSweep({ force: true }), { headers: ADMIN_NO_STORE });
	} catch {
		return json({ error: 'Retention sweep failed' }, { status: 503 });
	}
}
