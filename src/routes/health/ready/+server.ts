import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getSyncStore } from '$lib/server/syncStore';
import { backupManager } from '$lib/server/backupManager';

export const GET: RequestHandler = () => {
	const database = getSyncStore().isReady();
	const backup = backupManager.getStatus();
	const backupStuck =
		backup.running &&
		backup.lastAttemptAt > 0 &&
		Date.now() - backup.lastAttemptAt > 60 * 60 * 1000;
	const backupHealthy =
		!backup.enabled ||
		(!backupStuck && (backup.lastError === null || backup.lastSuccessAt >= backup.lastAttemptAt));
	const ready = database && backupHealthy;
	return json(
		{ ready, database, backup: { enabled: backup.enabled, healthy: backupHealthy } },
		{ status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
