import { env } from '$env/dynamic/private';

export const BYTES_PER_GIGABYTE = 1_000_000_000;
/** Default relay quota for self-host and Workers. Keep Docker and wrangler vars in lockstep. */
export const DEFAULT_MAX_ACCOUNT_BYTES = 100_000_000;
export const ACTIVITY_WINDOWS_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseMaxAccountBytes(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ACCOUNT_BYTES;
}

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
