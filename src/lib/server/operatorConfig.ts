import { env } from '$env/dynamic/private';

export { DEFAULT_MAX_ACCOUNT_BYTES, parseMaxAccountBytes } from '$lib/server/syncQuota';
export const BYTES_PER_GIGABYTE = 1_000_000_000;
export const ACTIVITY_WINDOWS_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRetentionInactiveDays(
	value = env.SCRAPSCACHE_RETENTION_INACTIVE_DAYS
): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

export function bytesToGigabytes(bytes: number): number {
	return Math.round((bytes / BYTES_PER_GIGABYTE) * 1_000_000) / 1_000_000;
}

export function staleBeforeMs(inactiveDays: number, now = Date.now()): number | null {
	return inactiveDays > 0 ? now - inactiveDays * DAY_MS : null;
}
