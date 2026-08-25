import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachSyncCloudIndicator, SYNC_ICON_ROTATION_MS } from './syncCloudIndicator';

const ROOT_CLASS = 'scrapscache-sync-active';

function isSpinning(): boolean {
	return document.documentElement.classList.contains(ROOT_CLASS);
}

function syncControl(): HTMLElement {
	const control = document.querySelector<HTMLElement>('[data-scrapscache-sync-control]');
	if (!control) throw new Error('missing sync control');
	return control;
}

describe('sync cloud indicator', () => {
	let store: { onSyncStart: (() => void) | null; onSyncEnd: (() => void) | null };

	beforeEach(() => {
		vi.useFakeTimers();
		document.documentElement.classList.remove(ROOT_CLASS);
		const control = document.createElement('button');
		control.setAttribute('data-scrapscache-sync-control', '');
		document.body.append(control);
		store = { onSyncStart: null, onSyncEnd: null };
		attachSyncCloudIndicator(store);
	});

	afterEach(() => {
		store.onSyncEnd?.();
		store.onSyncEnd?.();
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		document.body.replaceChildren();
		document.documentElement.classList.remove(ROOT_CLASS);
	});

	it('holds an instant sync for one full rotation', () => {
		store.onSyncStart?.();
		store.onSyncEnd?.();
		expect(isSpinning()).toBe(true);
		expect(syncControl().getAttribute('aria-busy')).toBe('true');
		vi.advanceTimersByTime(SYNC_ICON_ROTATION_MS - 1);
		expect(isSpinning()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(isSpinning()).toBe(false);
		expect(syncControl().getAttribute('aria-busy')).toBe('false');
	});

	it('keeps spinning past one rotation until a long sync ends', () => {
		store.onSyncStart?.();
		vi.advanceTimersByTime(SYNC_ICON_ROTATION_MS + 400);
		expect(isSpinning()).toBe(true);
		store.onSyncEnd?.();
		expect(isSpinning()).toBe(true);
		vi.advanceTimersByTime(0);
		expect(isSpinning()).toBe(false);
	});
});
