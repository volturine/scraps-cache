/** DOM-only cloud indicator: spins for the whole sync, with a short minimum
 * so instant syncs read as a deliberate pulse instead of a flicker. */

const ROOT_CLASS = 'shard-sync-active';
const MIN_SPIN_MS = 900;

let inFlight = 0;
let spinStartedAt = 0;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function setSpin(on: boolean): void {
	if (typeof document === 'undefined') return;
	document.documentElement.classList.toggle(ROOT_CLASS, on);
	for (const control of document.querySelectorAll<HTMLElement>('[data-shard-sync-control]')) {
		control.setAttribute('aria-label', on ? 'Sync settings, syncing' : 'Sync settings');
		control.setAttribute('aria-busy', String(on));
	}
}

function scheduleSpinOff(): void {
	if (hideTimer) clearTimeout(hideTimer);
	const delay = Math.max(0, MIN_SPIN_MS - (Date.now() - spinStartedAt));
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
