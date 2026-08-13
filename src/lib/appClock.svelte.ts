// Shared clock so overdue labels and reminder scans move forward without a remount.

export const appClock = $state({
	now: Date.now()
});

export function tickAppClock(now = Date.now()): void {
	appClock.now = now;
}
