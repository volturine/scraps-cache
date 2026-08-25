// Vitest setup: provide jsdom globals that Svelte components expect.
import 'vitest';
import 'fake-indexeddb/auto';
import { afterEach, vi } from 'vitest';
import { closeDeviceDatabase, DEVICE_DB_NAME } from '$lib/db/idb';
import { resetTombstoneCaches } from '$lib/syncTombstones';

// jsdom lacks matchMedia; add a minimal stub.
if (typeof window !== 'undefined' && !window.matchMedia) {
	window.matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	});
}

// jsdom does not implement Web Animations, which Svelte transitions use.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
	Element.prototype.animate = (() => {
		const animation = {
			cancel: () => undefined,
			currentTime: 0,
			effect: null,
			onfinish: null as (() => void) | null,
			playState: 'finished'
		};
		queueMicrotask(() => animation.onfinish?.());
		return animation;
	}) as unknown as typeof Element.prototype.animate;
}

function deleteDatabase(name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => resolve();
	});
}

afterEach(async () => {
	vi.useRealTimers();
	closeDeviceDatabase();
	resetTombstoneCaches();
	await deleteDatabase(DEVICE_DB_NAME);
});
