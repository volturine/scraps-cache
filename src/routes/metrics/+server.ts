import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { renderMetrics } from '$lib/server/metrics';
import { backupManager } from '$lib/server/backupManager';
import { getSyncStore } from '$lib/server/syncStore';

export const GET: RequestHandler = ({ request }) => {
	const expected = env.SHARD_ADMIN_TOKEN;
	if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
		return new Response('Not found\n', { status: 404 });
	}
	return new Response(renderMetrics(backupManager.getStatus(), getSyncStore().aggregateUsage()), {
		headers: {
			'content-type': 'text/plain; version=0.0.4; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
};
