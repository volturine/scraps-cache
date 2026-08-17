import type { RequestHandler } from './$types';
import { isAdminAuthorized, unauthorizedAdminResponse } from '$lib/server/adminAuth';
import { renderMetrics } from '$lib/server/metrics';
import {
	bytesToGigabytes,
	parseRetentionInactiveDays,
	staleBeforeMs
} from '$lib/server/operatorConfig';
import { retentionManager } from '$lib/server/retentionManager';
import { backupManager } from '$lib/server/backupManager';
import { getSyncStore } from '$lib/server/syncStore';

export const GET: RequestHandler = ({ request }) => {
	if (!isAdminAuthorized(request)) return unauthorizedAdminResponse();
	const now = Date.now();
	const usage = getSyncStore().operatorUsage({
		now,
		staleBefore: staleBeforeMs(parseRetentionInactiveDays(), now)
	});
	return new Response(
		renderMetrics(
			backupManager.getStatus(),
			{
				...usage,
				gigabytes: bytesToGigabytes(usage.ciphertextBytes)
			},
			retentionManager.getStatus()
		),
		{
			headers: {
				'content-type': 'text/plain; version=0.0.4; charset=utf-8',
				'cache-control': 'no-store'
			}
		}
	);
};
