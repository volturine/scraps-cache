import { env } from '$env/dynamic/private';
import { parseRetentionInactiveDays, staleBeforeMs } from '$lib/server/operatorConfig';
import { getDb, getMeta, setMeta, type Db } from '$lib/server/db';
import { getSyncStore, type SyncStore } from '$lib/server/syncStore';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATUS_META_KEY = 'retention-status-v1';

export type RetentionStatus = {
	enabled: boolean;
	inactiveDays: number;
	lastRunAt: number;
	lastSuccessAt: number;
	lastDeletedAccounts: number;
	deletedAccountsTotal: number;
	lastPurgedSlots: number;
	failures: number;
	lastError: string | null;
};

export type RetentionStore = {
	deleteInactiveAccounts(staleBefore: number): Promise<number>;
	purgeExpiredDeletedEnvelopes(now?: number): Promise<number>;
};

export type RetentionSweepOptions = {
	inactiveDays?: number;
	store?: RetentionStore;
	db?: Db;
	now?: () => number;
	force?: boolean;
};

function inactiveDaysFromEnv(): number {
	return parseRetentionInactiveDays(env.SCRAPSCACHE_RETENTION_INACTIVE_DAYS);
}

function emptyStatus(inactiveDays: number): RetentionStatus {
	return {
		enabled: inactiveDays > 0,
		inactiveDays,
		lastRunAt: 0,
		lastSuccessAt: 0,
		lastDeletedAccounts: 0,
		deletedAccountsTotal: 0,
		lastPurgedSlots: 0,
		failures: 0,
		lastError: null
	};
}

export async function getRetentionStatus(db: Db = getDb()): Promise<RetentionStatus> {
	await db.ready;
	const inactiveDays = inactiveDaysFromEnv();
	const stored = await getMeta(db, STATUS_META_KEY);
	if (!stored) return emptyStatus(inactiveDays);
	try {
		const parsed = JSON.parse(stored) as Partial<RetentionStatus>;
		return { ...emptyStatus(inactiveDays), ...parsed, enabled: inactiveDays > 0, inactiveDays };
	} catch {
		return emptyStatus(inactiveDays);
	}
}

/** Purge grace-expired deleted slots and remove long-inactive accounts, at most
 * once per day unless forced. Status persists in the ops store so every isolate
 * and the operator endpoints observe the same sweep history. */
export async function runRetentionSweep(
	options: RetentionSweepOptions = {}
): Promise<RetentionStatus | null> {
	const db = options.db ?? getDb();
	const store: RetentionStore = options.store ?? getSyncStore();
	const now = options.now?.() ?? Date.now();
	const inactiveDays = options.inactiveDays ?? inactiveDaysFromEnv();
	await db.ready;
	const previous = await getRetentionStatus(db);
	if (!options.force && now - previous.lastRunAt < RETENTION_INTERVAL_MS) return null;
	try {
		const purgedSlots = await store.purgeExpiredDeletedEnvelopes(now);
		let deletedAccounts = 0;
		const cutoff = staleBeforeMs(inactiveDays, now);
		if (cutoff != null) deletedAccounts = await store.deleteInactiveAccounts(cutoff);
		const status: RetentionStatus = {
			...previous,
			enabled: inactiveDays > 0,
			inactiveDays,
			lastRunAt: now,
			lastSuccessAt: now,
			lastDeletedAccounts: deletedAccounts,
			deletedAccountsTotal: previous.deletedAccountsTotal + deletedAccounts,
			lastPurgedSlots: purgedSlots,
			lastError: null
		};
		await setMeta(db, STATUS_META_KEY, JSON.stringify(status));
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'retention_sweep',
				deletedAccounts,
				purgedSlots,
				inactiveDays
			})
		);
		return status;
	} catch (error) {
		const status: RetentionStatus = {
			...previous,
			enabled: inactiveDays > 0,
			inactiveDays,
			lastRunAt: now,
			failures: previous.failures + 1,
			lastError: error instanceof Error ? error.message : 'Retention sweep failed'
		};
		await setMeta(db, STATUS_META_KEY, JSON.stringify(status));
		console.error(
			JSON.stringify({
				level: 'error',
				event: 'retention_failed',
				message: status.lastError
			})
		);
		throw error;
	}
}
