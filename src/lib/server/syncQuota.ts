/** Default relay quota for self-host and Workers. Keep Docker and wrangler vars in lockstep. */
export const DEFAULT_MAX_ACCOUNT_BYTES = 100_000_000;

export function parseMaxAccountBytes(value: string | undefined): number {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_ACCOUNT_BYTES;
}
