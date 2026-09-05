import { ACTIVITY_WINDOWS_DAYS } from '$lib/server/operatorConfig';
import { parseMaxAccountBytes } from '$lib/server/syncQuota';
import { batch, execute, type SqlStatement } from './d1';
import { cloudflareBindings } from './env';
import { syncThroughCoordinator, SyncQuotaExceededError } from './coordinatorSync';

export { SyncQuotaExceededError };

export type EncryptedEnvelope = { seq: number; id: string; ciphertext: string; slot: string };
export type OpaqueUpload = Omit<EncryptedEnvelope, 'seq'> & { expectedId?: string | null };
export type OpaqueDelete = { id: string; slot: string };
export type SyncResult = {
	cursor: number;
	envelopes: EncryptedEnvelope[];
	conflicts: EncryptedEnvelope[];
	hasMore: boolean;
	reset: boolean;
	writesAccepted: boolean;
};
export type SyncQuotas = { maxAccountBytes: number };
export type AccountByteQuota = { maxBytes: number; overridden: boolean };
export type AccountUsage = AccountByteQuota & {
	envelopeCount: number;
	ciphertextBytes: number;
	storageBytes: number;
};
export type OperatorUsage = {
	accounts: number;
	envelopeCount: number;
	ciphertextBytes: number;
	storageBytes: number;
	activeByWindowDays: Record<string, number>;
	staleAccounts: number;
};
export type PushDeviceInput = {
	deviceId: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	accountId: string;
};
export type ReminderWakeInput = { id: string; fireAt: number };
export type DueWake = PushDeviceInput & { wakeId: string; fireAt: number };

export const ENVELOPE_STORAGE_OVERHEAD_BYTES = 512;
export const MAX_PUSH_DEVICES = 32;
export const MAX_WAKES_PER_ACCOUNT = 1_000;
export const WAKE_RETAIN_MS = 86_400_000;
export const WAKE_CLAIM_LEASE_MS = 60_000;
export const DELETED_SLOT_GRACE_MS = 14 * 86_400_000;
/** Keeps D1 parameters and R2 subrequests safely inside Workers limits. */
export const MAX_SYNC_MUTATIONS_PER_REQUEST = 8;

export class SyncStore {
	private readonly bindings = cloudflareBindings();
	private readonly maxAccountBytes = parseMaxAccountBytes(
		this.bindings.SCRAPSCACHE_SYNC_MAX_ACCOUNT_BYTES
	);
	private get db() {
		return this.bindings.SCRAPSCACHE_DB;
	}

	async getAuthCredential(accountId: string): Promise<string | null> {
		const row = (
			await execute(this.db, {
				sql: 'SELECT credential_hash AS credentialHash FROM accounts WHERE account_id = ?',
				args: [accountId]
			})
		).rows[0];
		return row ? String(row.credentialHash) : null;
	}
	async replaceAuthCredential(
		accountId: string,
		expected: string,
		replacement: string
	): Promise<boolean> {
		return (
			(
				await execute(this.db, {
					sql: 'UPDATE accounts SET credential_hash = ?, updated_at = ? WHERE account_id = ? AND credential_hash = ?',
					args: [replacement, Date.now(), accountId, expected]
				})
			).rowsAffected === 1
		);
	}
	async createAccount(
		accountId: string,
		authPublicKey: string,
		updatedAt = Date.now()
	): Promise<boolean> {
		return (
			(
				await execute(this.db, {
					sql: 'INSERT OR IGNORE INTO accounts(account_id, credential_hash, updated_at, last_seen_at) VALUES (?, ?, ?, ?)',
					args: [accountId, authPublicKey, updatedAt, updatedAt]
				})
			).rowsAffected === 1
		);
	}
	async getAccountByteQuota(accountId: string): Promise<AccountByteQuota | null> {
		const row = (
			await execute(this.db, {
				sql: 'SELECT q.max_bytes AS maxBytes FROM accounts a LEFT JOIN account_quotas q USING(account_id) WHERE a.account_id = ?',
				args: [accountId]
			})
		).rows[0];
		if (!row) return null;
		return {
			maxBytes: row.maxBytes == null ? this.maxAccountBytes : Number(row.maxBytes),
			overridden: row.maxBytes != null
		};
	}
	async getAccountUsage(accountId: string): Promise<AccountUsage | null> {
		const row = (
			await execute(this.db, {
				sql: 'SELECT a.envelope_count AS envelopeCount,a.ciphertext_bytes AS ciphertextBytes,q.max_bytes AS maxBytes FROM accounts a LEFT JOIN account_quotas q USING(account_id) WHERE a.account_id=?',
				args: [accountId]
			})
		).rows[0];
		if (!row) return null;
		const envelopeCount = Number(row.envelopeCount);
		const ciphertextBytes = Number(row.ciphertextBytes);
		return {
			envelopeCount,
			ciphertextBytes,
			storageBytes: ciphertextBytes + envelopeCount * ENVELOPE_STORAGE_OVERHEAD_BYTES,
			maxBytes: row.maxBytes == null ? this.maxAccountBytes : Number(row.maxBytes),
			overridden: row.maxBytes != null
		};
	}
	async setAccountByteQuota(accountId: string, maxBytes: number): Promise<boolean> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
			throw new RangeError('Account byte quota must be a positive safe integer');
		return (
			(
				await execute(this.db, {
					sql: 'INSERT INTO account_quotas(account_id,max_bytes) SELECT account_id,? FROM accounts WHERE account_id=? ON CONFLICT(account_id) DO UPDATE SET max_bytes=excluded.max_bytes',
					args: [maxBytes, accountId]
				})
			).rowsAffected === 1
		);
	}
	async clearAccountByteQuota(accountId: string): Promise<boolean> {
		if (!(await this.getAuthCredential(accountId))) return false;
		await execute(this.db, {
			sql: 'DELETE FROM account_quotas WHERE account_id=?',
			args: [accountId]
		});
		return true;
	}
	async sync(
		accountId: string,
		cursor: number,
		uploads: OpaqueUpload[],
		deletions: OpaqueDelete[],
		downloadLimit = 12
	): Promise<
		SyncResult & {
			usage: {
				envelopeCount: number;
				ciphertextBytes: number;
				storageBytes: number;
				maxBytes: number;
			};
		}
	> {
		return (await syncThroughCoordinator(this.bindings.ACCOUNT_COORDINATOR, {
			accountId,
			cursor,
			uploads,
			deletions,
			downloadLimit,
			maxAccountBytes: this.maxAccountBytes
		})) as SyncResult & {
			usage: {
				envelopeCount: number;
				ciphertextBytes: number;
				storageBytes: number;
				maxBytes: number;
			};
		};
	}
	async deleteAccount(accountId: string): Promise<boolean> {
		const namespace = this.bindings.ACCOUNT_COORDINATOR;
		const response = await namespace
			.get(namespace.idFromName(accountId))
			.fetch('https://coordinator/delete', {
				method: 'POST',
				body: JSON.stringify({ accountId })
			});
		if (!response.ok) throw new Error(`Account coordinator failed (${response.status})`);
		return Boolean(((await response.json()) as { deleted?: unknown }).deleted);
	}
	async touchAccount(accountId: string, now = Date.now()): Promise<void> {
		await execute(this.db, {
			sql: 'UPDATE accounts SET last_seen_at=? WHERE account_id=?',
			args: [now, accountId]
		});
	}
	getQuotas(): SyncQuotas {
		return { maxAccountBytes: this.maxAccountBytes };
	}
	async operatorUsage(
		options: { now?: number; staleBefore?: number | null } = {}
	): Promise<OperatorUsage> {
		const now = options.now ?? Date.now(),
			stale = options.staleBefore ?? null;
		const selects = ACTIVITY_WINDOWS_DAYS.map(
			(_, i) => `COALESCE(SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END),0) AS active_${i}`
		).join(',');
		const row = (
			await execute(this.db, {
				sql: `SELECT COUNT(*) accounts,COALESCE(SUM(envelope_count),0) envelopeCount,COALESCE(SUM(ciphertext_bytes),0) ciphertextBytes,${selects},COALESCE(SUM(CASE WHEN last_seen_at < ? THEN 1 ELSE 0 END),0) staleAccounts FROM accounts`,
				args: [...ACTIVITY_WINDOWS_DAYS.map((d) => now - d * 86_400_000), stale ?? 0]
			})
		).rows[0]!;
		const activeByWindowDays = Object.fromEntries(
			ACTIVITY_WINDOWS_DAYS.map((d, i) => [String(d), Number(row[`active_${i}`])])
		);
		const envelopeCount = Number(row.envelopeCount),
			ciphertextBytes = Number(row.ciphertextBytes);
		return {
			accounts: Number(row.accounts),
			envelopeCount,
			ciphertextBytes,
			storageBytes: ciphertextBytes + envelopeCount * ENVELOPE_STORAGE_OVERHEAD_BYTES,
			activeByWindowDays,
			staleAccounts: stale == null ? 0 : Number(row.staleAccounts)
		};
	}
	async deleteInactiveAccounts(staleBefore: number): Promise<number> {
		const rows = (
			await execute(this.db, {
				sql: 'SELECT account_id AS accountId FROM accounts WHERE last_seen_at < ?',
				args: [staleBefore]
			})
		).rows;
		for (const row of rows) await this.deleteAccount(String(row.accountId));
		return rows.length;
	}
	async purgeExpiredDeletedEnvelopes(
		now = Date.now(),
		graceMs = DELETED_SLOT_GRACE_MS
	): Promise<number> {
		const rows = (
			await execute(this.db, {
				sql: 'SELECT account_id AS accountId,slot,r2_key AS r2Key FROM deleted_envelopes WHERE deleted_at <= ?',
				args: [now - graceMs]
			})
		).rows;
		await batch(
			this.db,
			rows.map((r) => ({
				sql: 'DELETE FROM deleted_envelopes WHERE account_id=? AND slot=?',
				args: [String(r.accountId), String(r.slot)]
			}))
		);
		await Promise.all(rows.map((r) => this.bindings.SCRAPSCACHE_ENVELOPES.delete(String(r.r2Key))));
		return rows.length;
	}
	async savePushDevice(d: PushDeviceInput): Promise<void> {
		await batch(this.db, [
			{
				sql: 'DELETE FROM reminder_push_devices WHERE endpoint=? AND (account_id!=? OR device_id!=?)',
				args: [d.endpoint, d.accountId, d.deviceId]
			},
			{
				sql: 'DELETE FROM reminder_push_devices WHERE device_id=? AND account_id!=?',
				args: [d.deviceId, d.accountId]
			},
			{
				sql: 'INSERT INTO reminder_push_devices(account_id,device_id,endpoint,p256dh,auth,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,device_id) DO UPDATE SET endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at',
				args: [d.accountId, d.deviceId, d.endpoint, d.p256dh, d.auth, Date.now()]
			},
			{
				sql: 'DELETE FROM reminder_push_devices WHERE account_id=? AND device_id IN (SELECT device_id FROM reminder_push_devices WHERE account_id=? ORDER BY updated_at DESC LIMIT -1 OFFSET ?)',
				args: [d.accountId, d.accountId, MAX_PUSH_DEVICES]
			}
		]);
		await this.touchAccount(d.accountId);
	}
	async replaceReminderWakes(
		accountId: string,
		wakes: ReminderWakeInput[],
		revision?: number
	): Promise<boolean> {
		if (!(await this.getAuthCredential(accountId))) return false;
		if (revision !== undefined) {
			const current = (
				await execute(this.db, {
					sql: 'SELECT revision FROM reminder_wake_revisions WHERE account_id=?',
					args: [accountId]
				})
			).rows[0];
			if (current && revision < Number(current.revision)) return false;
			if (current && revision === Number(current.revision)) return true;
		}
		const statements: SqlStatement[] = [
			{ sql: 'DELETE FROM reminder_wakes WHERE account_id=?', args: [accountId] },
			...wakes.slice(0, MAX_WAKES_PER_ACCOUNT).map((w) => ({
				sql: 'INSERT INTO reminder_wakes(account_id,wake_id,fire_at) VALUES(?,?,?)',
				args: [accountId, w.id, w.fireAt]
			}))
		];
		if (revision !== undefined)
			statements.push({
				sql: 'INSERT INTO reminder_wake_revisions(account_id,revision) VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision',
				args: [accountId, revision]
			});
		await batch(this.db, statements);
		await this.touchAccount(accountId);
		return true;
	}
	async claimDueWakes(now: number, limit = 100): Promise<DueWake[]> {
		const rows = (
			await execute(this.db, {
				sql: 'SELECT d.account_id accountId,d.device_id deviceId,w.wake_id wakeId,w.fire_at fireAt,d.endpoint,d.p256dh,d.auth FROM reminder_wakes w JOIN reminder_push_devices d ON d.account_id=w.account_id LEFT JOIN reminder_wake_deliveries x ON x.account_id=d.account_id AND x.device_id=d.device_id AND x.wake_id=w.wake_id WHERE w.fire_at<=? AND x.delivered_at IS NULL AND (x.claimed_at IS NULL OR x.claimed_at<=?) ORDER BY w.fire_at,w.wake_id,d.device_id LIMIT ?',
				args: [now, now - WAKE_CLAIM_LEASE_MS, limit]
			})
		).rows as unknown as DueWake[];
		await batch(
			this.db,
			rows.map((r) => ({
				sql: 'INSERT INTO reminder_wake_deliveries(account_id,device_id,wake_id,claimed_at,delivered_at) VALUES(?,?,?,?,NULL) ON CONFLICT(account_id,device_id,wake_id) DO UPDATE SET claimed_at=excluded.claimed_at,delivered_at=NULL',
				args: [r.accountId, r.deviceId, r.wakeId, now]
			}))
		);
		return rows;
	}
	async markWakeDelivered(
		w: Pick<DueWake, 'accountId' | 'deviceId' | 'wakeId'>,
		now: number
	): Promise<void> {
		await execute(this.db, {
			sql: 'UPDATE reminder_wake_deliveries SET delivered_at=? WHERE account_id=? AND device_id=? AND wake_id=?',
			args: [now, w.accountId, w.deviceId, w.wakeId]
		});
	}
	async releaseWakeClaim(w: Pick<DueWake, 'accountId' | 'deviceId' | 'wakeId'>): Promise<void> {
		await execute(this.db, {
			sql: 'DELETE FROM reminder_wake_deliveries WHERE account_id=? AND device_id=? AND wake_id=? AND delivered_at IS NULL',
			args: [w.accountId, w.deviceId, w.wakeId]
		});
	}
	async pruneStaleWakes(now: number, retainMs = WAKE_RETAIN_MS): Promise<void> {
		await batch(this.db, [
			{ sql: 'DELETE FROM reminder_wakes WHERE fire_at < ?', args: [now - retainMs] },
			{
				sql: 'DELETE FROM reminder_wake_deliveries WHERE COALESCE(delivered_at,claimed_at) < ?',
				args: [now - retainMs]
			}
		]);
	}
	async deletePushDevice(accountId: string, deviceId: string): Promise<void> {
		await execute(this.db, {
			sql: 'DELETE FROM reminder_push_devices WHERE account_id=? AND device_id=?',
			args: [accountId, deviceId]
		});
		await this.touchAccount(accountId);
	}
	async countPushDevices(accountId?: string): Promise<number> {
		const r = await execute(
			this.db,
			accountId
				? {
						sql: 'SELECT COUNT(*) count FROM reminder_push_devices WHERE account_id=?',
						args: [accountId]
					}
				: 'SELECT COUNT(*) count FROM reminder_push_devices'
		);
		return Number(r.rows[0]?.count ?? 0);
	}
	async isReady(): Promise<boolean> {
		try {
			await execute(this.db, 'SELECT 1');
			return true;
		} catch (error) {
			console.error(
				JSON.stringify({
					level: 'error',
					event: 'cloudflare_storage_not_ready',
					message: error instanceof Error ? error.message : 'D1 readiness check failed'
				})
			);
			return false;
		}
	}
}

let singleton: SyncStore | undefined;
export function getSyncStore(): SyncStore {
	return (singleton ??= new SyncStore());
}
