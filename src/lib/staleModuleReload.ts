export const STALE_MODULE_RELOAD_KEY = 'scrapscache-stale-module-reload';
export const STALE_MODULE_RELOAD_COOLDOWN_MS = 15_000;

export function isMissingModuleError(cause: unknown): boolean {
	return (
		cause instanceof Error && cause.message.includes('Failed to fetch dynamically imported module')
	);
}

export function reloadOnceForMissingModule(
	cause: unknown,
	now = Date.now(),
	reload = () => location.reload()
): boolean {
	if (!isMissingModuleError(cause)) return false;
	try {
		const last = Number(sessionStorage.getItem(STALE_MODULE_RELOAD_KEY) ?? 0);
		if (last && now - last < STALE_MODULE_RELOAD_COOLDOWN_MS) return false;
		sessionStorage.setItem(STALE_MODULE_RELOAD_KEY, String(now));
	} catch {
		return false;
	}
	reload();
	return true;
}
