import { backupManager, type BackupStatus } from '$lib/server/backupManager';
import { processActivity, type ProcessActivity } from '$lib/server/metrics';
import {
	bytesToGigabytes,
	parseRetentionInactiveDays,
	staleBeforeMs
} from '$lib/server/operatorConfig';
import { retentionManager, type RetentionStatus } from '$lib/server/retentionManager';
import { getSyncStore, type OperatorUsage, type SyncQuotas } from '$lib/server/syncStore';

export type OperatorSnapshot = {
	generatedAt: number;
	storage: {
		ciphertextBytes: number;
		gigabytes: number;
		envelopes: number;
	};
	accounts: {
		total: number;
		active: Record<string, number>;
		staleForRetention: number | null;
	};
	activity: ProcessActivity;
	retention: RetentionStatus;
	quotas: SyncQuotas;
	backup: BackupStatus;
};

export function buildOperatorSnapshot(
	usage: OperatorUsage,
	quotas: SyncQuotas,
	activity: ProcessActivity,
	retention: RetentionStatus,
	backup: BackupStatus,
	now: number,
	retentionInactiveDays: number
): OperatorSnapshot {
	return {
		generatedAt: now,
		storage: {
			ciphertextBytes: usage.ciphertextBytes,
			gigabytes: bytesToGigabytes(usage.ciphertextBytes),
			envelopes: usage.envelopeCount
		},
		accounts: {
			total: usage.accounts,
			active: usage.activeByWindowDays,
			staleForRetention: retentionInactiveDays > 0 ? usage.staleAccounts : null
		},
		activity,
		retention,
		quotas,
		backup
	};
}

export function getOperatorSnapshot(now = Date.now()) {
	const store = getSyncStore();
	const retentionInactiveDays = parseRetentionInactiveDays();
	const usage = store.operatorUsage({
		now,
		staleBefore: staleBeforeMs(retentionInactiveDays, now)
	});
	return buildOperatorSnapshot(
		usage,
		store.getQuotas(),
		processActivity(),
		retentionManager.getStatus(),
		backupManager.getStatus(),
		now,
		retentionInactiveDays
	);
}
