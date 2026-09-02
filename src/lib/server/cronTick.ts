import { getDb } from '$lib/server/db';
import { getSyncAuth } from '$lib/server/syncAuth';
import { getPairingSessions } from '$lib/server/pairingSessions';
import { pruneRateBuckets } from '$lib/server/rateLimit';
import { dispatchDueWakes, type WakeDispatchResult } from '$lib/server/wakeDispatch';
import {
	getRetentionStatus,
	runRetentionSweep,
	type RetentionStatus
} from '$lib/server/retentionSweep';

export type CronTickResult = {
	wakes: WakeDispatchResult;
	retention: RetentionStatus;
	retentionSkipped: boolean;
};

/** One scheduler pass: deliver due reminder wakes, run the daily retention sweep
 * when due, and prune expired operational state. Invoked every minute by the
 * platform cron (Workers Cron Trigger or a self-host system crontab). */
export async function runCronTick(now = Date.now()): Promise<CronTickResult> {
	const db = getDb();
	await db.ready;
	const wakes = await dispatchDueWakes({ now: () => now });
	const retention = await runRetentionSweep({ now: () => now });
	await pruneRateBuckets(db, now);
	await getSyncAuth().pruneExpired(now);
	await getPairingSessions().prune(now);
	return {
		wakes,
		retention: retention ?? (await getRetentionStatus(db)),
		retentionSkipped: retention == null
	};
}
