export const SyncStatus = {
	Normal: 'normal',
	Warning: 'warning',
	Danger: 'danger'
} as const;

export type SyncStatus = (typeof SyncStatus)[keyof typeof SyncStatus];

export function resolveSyncStatus(
	lastError: string | null | undefined,
	usage: { storageBytes: number; maxBytes: number } | null | undefined
): SyncStatus {
	if (lastError) return SyncStatus.Danger;
	if (!usage) return SyncStatus.Normal;
	const ratio = usage.storageBytes / usage.maxBytes;
	if (ratio >= 1) return SyncStatus.Danger;
	if (ratio >= 0.8) return SyncStatus.Warning;
	return SyncStatus.Normal;
}
