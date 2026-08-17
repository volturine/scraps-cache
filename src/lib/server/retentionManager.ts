import { env } from '$env/dynamic/private';
import { parseRetentionInactiveDays, staleBeforeMs } from '$lib/server/operatorConfig';
import { getSyncStore } from '$lib/server/syncStore';

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RetentionStatus = {
	enabled: boolean;
	running: boolean;
	inactiveDays: number;
	lastRunAt: number;
	lastSuccessAt: number;
	lastDeletedAccounts: number;
	deletedAccountsTotal: number;
	failures: number;
	lastError: string | null;
};

export type RetentionStore = {
	deleteInactiveAccounts(staleBefore: number): number;
};

export type RetentionManagerOptions = {
	inactiveDays?: number;
	store?: RetentionStore;
	now?: () => number;
};

export class RetentionManager {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private readonly inactiveDays: number;
	private readonly getStore: () => RetentionStore;
	private readonly now: () => number;
	private status: RetentionStatus;

	constructor(options: RetentionManagerOptions = {}) {
		this.inactiveDays =
			options.inactiveDays ?? parseRetentionInactiveDays(env.SCRAPS_CACHE_RETENTION_INACTIVE_DAYS);
		this.getStore = options.store ? () => options.store! : () => getSyncStore();
		this.now = options.now ?? Date.now;
		this.status = {
			enabled: this.inactiveDays > 0,
			running: false,
			inactiveDays: this.inactiveDays,
			lastRunAt: 0,
			lastSuccessAt: 0,
			lastDeletedAccounts: 0,
			deletedAccountsTotal: 0,
			failures: 0,
			lastError: null
		};
	}

	start(): void {
		if (this.started || this.inactiveDays <= 0) return;
		this.started = true;
		this.schedule(Math.min(60_000, RETENTION_INTERVAL_MS));
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.started = false;
	}

	getStatus(): RetentionStatus {
		return { ...this.status };
	}

	async runNow(): Promise<RetentionStatus> {
		if (this.inactiveDays <= 0) throw new Error('Account retention is not configured');
		if (this.status.running) return this.getStatus();
		this.status.running = true;
		this.status.lastRunAt = this.now();
		try {
			const cutoff = staleBeforeMs(this.inactiveDays, this.now());
			if (cutoff == null) throw new Error('Account retention is not configured');
			const deleted = this.getStore().deleteInactiveAccounts(cutoff);
			this.status.lastSuccessAt = this.now();
			this.status.lastDeletedAccounts = deleted;
			this.status.deletedAccountsTotal += deleted;
			this.status.lastError = null;
			console.info(
				JSON.stringify({
					level: 'info',
					event: 'retention_sweep',
					deletedAccounts: deleted,
					inactiveDays: this.inactiveDays
				})
			);
		} catch (error) {
			this.status.failures += 1;
			this.status.lastError = error instanceof Error ? error.message : 'Retention sweep failed';
			console.error(
				JSON.stringify({
					level: 'error',
					event: 'retention_failed',
					message: this.status.lastError
				})
			);
			throw error;
		} finally {
			this.status.running = false;
			if (this.started) this.schedule(RETENTION_INTERVAL_MS);
		}
		return this.getStatus();
	}

	private schedule(delay: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.runNow().catch(() => {
				/* already logged */
			});
		}, delay);
		this.timer.unref?.();
	}
}

export const retentionManager = new RetentionManager();
