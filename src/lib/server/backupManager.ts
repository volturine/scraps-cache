import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getSyncStore } from '$lib/server/syncStore';

export type BackupStatus = {
	enabled: boolean;
	running: boolean;
	lastAttemptAt: number;
	lastSuccessAt: number;
	failures: number;
	durationMs: number;
	lastError: string | null;
	lastFile: string | null;
};

export type BackupSource = {
	backup(destination: string): Promise<void>;
};

export type BackupManagerOptions = {
	directory?: string;
	intervalHours?: number;
	retain?: number;
	source?: BackupSource;
};

function positiveNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Remove SQLite companion files left after opening a WAL-mode snapshot. */
function removeSqliteCompanions(databasePath: string): void {
	rmSync(`${databasePath}-wal`, { force: true });
	rmSync(`${databasePath}-shm`, { force: true });
	rmSync(`${databasePath}-journal`, { force: true });
}

export class BackupManager {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private readonly directory: string;
	private readonly intervalMs: number;
	private readonly retain: number;
	private readonly source: BackupSource;
	private status: BackupStatus;

	constructor(options: BackupManagerOptions = {}) {
		this.directory = options.directory ?? env.SHARD_BACKUP_DIR ?? '';
		this.intervalMs =
			positiveNumber(
				options.intervalHours !== undefined
					? String(options.intervalHours)
					: env.SHARD_BACKUP_INTERVAL_HOURS,
				24
			) *
			60 *
			60 *
			1000;
		this.retain = Math.max(
			1,
			Math.floor(
				positiveNumber(
					options.retain !== undefined ? String(options.retain) : env.SHARD_BACKUP_RETAIN,
					2
				)
			)
		);
		this.source = options.source ?? {
			backup: (destination) => getSyncStore().backup(destination)
		};
		this.status = {
			enabled: Boolean(this.directory),
			running: false,
			lastAttemptAt: 0,
			lastSuccessAt: 0,
			failures: 0,
			durationMs: 0,
			lastError: null,
			lastFile: null
		};
	}

	start(): void {
		if (this.started || !this.directory) return;
		this.started = true;
		mkdirSync(this.directory, { recursive: true });
		this.schedule(Math.min(60_000, this.intervalMs));
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.started = false;
	}

	getStatus(): BackupStatus {
		return { ...this.status };
	}

	async runNow(): Promise<BackupStatus> {
		if (!this.directory) throw new Error('Server backups are not configured');
		if (this.status.running) return this.getStatus();
		this.status.running = true;
		this.status.lastAttemptAt = Date.now();
		const startedAt = Date.now();
		const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
		const temporary = join(this.directory, `.shard-sync-${stamp}.tmp.sqlite`);
		const destination = join(this.directory, `shard-sync-${stamp}.sqlite`);
		try {
			mkdirSync(this.directory, { recursive: true });
			await this.source.backup(temporary);
			// Source stores use WAL; the online backup is a single file whose header may still
			// request WAL. Open read/write long enough to checkpoint into a standalone file,
			// verify integrity, then promote atomically.
			const verification = new Database(temporary, { fileMustExist: true });
			try {
				verification.pragma('journal_mode = DELETE');
				const result = verification.pragma('integrity_check', { simple: true });
				if (result !== 'ok') throw new Error('SQLite integrity check failed');
			} finally {
				verification.close();
			}
			removeSqliteCompanions(temporary);
			renameSync(temporary, destination);
			this.status.lastSuccessAt = Date.now();
			this.status.lastError = null;
			this.status.lastFile = destination;
			this.prune();
		} catch (error) {
			this.status.failures += 1;
			this.status.lastError = error instanceof Error ? error.message : 'Backup failed';
			rmSync(temporary, { force: true });
			removeSqliteCompanions(temporary);
			throw error;
		} finally {
			this.status.running = false;
			this.status.durationMs = Date.now() - startedAt;
			if (this.started) this.schedule(this.intervalMs);
		}
		return this.getStatus();
	}

	private schedule(delay: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.runNow().catch((error) => {
				console.error(
					JSON.stringify({
						level: 'error',
						event: 'backup_failed',
						message: error instanceof Error ? error.message : 'Backup failed'
					})
				);
			});
		}, delay);
		this.timer.unref?.();
	}

	private prune(): void {
		const files = readdirSync(this.directory)
			.filter((file) => /^shard-sync-.*\.sqlite$/.test(file))
			.sort()
			.reverse();
		for (const file of files.slice(this.retain)) {
			rmSync(join(this.directory, file), { force: true });
		}
	}
}

export const backupManager = new BackupManager();
