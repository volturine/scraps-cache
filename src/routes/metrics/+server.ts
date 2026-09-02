import type { RequestHandler } from './$types';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { renderMetrics } from '$lib/server/metrics';
import {
	bytesToGigabytes,
	parseRetentionInactiveDays,
	staleBeforeMs
} from '$lib/server/operatorConfig';
import { getRetentionStatus } from '$lib/server/retentionSweep';
import { getSyncStore } from '$lib/server/syncStore';

export const GET: RequestHandler = async ({ request }) => {
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
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
				'cache-control': 'no-store'
			}
		}
	);
};
