/** DOM-only cloud indicator: spins for max(sync time, one rotation).
 * Instant syncs hold the class until one CSS turn finishes (1s in app.css). */

const ROOT_CLASS = 'scrapscache-sync-active';
export const SYNC_ICON_ROTATION_MS = 1000;

let inFlight = 0;
let spinStartedAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function setSpin(on: boolean): void {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle(ROOT_CLASS, on);
	for (const control of document.querySelectorAll<HTMLElement>('[data-scrapscache-sync-control]')) {
		control.setAttribute('aria-label', on ? 'Sync settings, syncing' : 'Sync settings');
		control.setAttribute('aria-busy', String(on));
	}
}

function scheduleSpinOff(): void {
	if (hideTimer) clearTimeout(hideTimer);
	const delay = Math.max(0, SYNC_ICON_ROTATION_MS - (Date.now() - spinStartedAt));
	hideTimer = setTimeout(() => {
		hideTimer = null;
		if (inFlight <= 0) setSpin(false);
	}, delay);
}

export function attachSyncCloudIndicator(store: {
	onSyncStart: (() => void) | null;
	onSyncEnd: (() => void) | null;
}): void {
	store.onSyncStart = () => {
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		inFlight++;
		spinStartedAt = Date.now();
		setSpin(true);
	};
	store.onSyncEnd = () => {
		inFlight = Math.max(0, inFlight - 1);
		if (inFlight === 0) scheduleSpinOff();
	};
}
