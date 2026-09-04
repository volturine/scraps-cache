import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	isMissingModuleError,
	reloadOnceForMissingModule,
	STALE_MODULE_RELOAD_COOLDOWN_MS,
	STALE_MODULE_RELOAD_KEY
} from './staleModuleReload';

const missing = new Error(
	'Failed to fetch dynamically imported module: https://scrapscache.com/_app/immutable/chunks/BtqWIj7_.js'
);

describe('staleModuleReload', () => {
	afterEach(() => {
		sessionStorage.removeItem(STALE_MODULE_RELOAD_KEY);
	});

	it('detects the browser missing-module fetch error', () => {
		expect(isMissingModuleError(missing)).toBe(true);
		expect(isMissingModuleError(new Error('Could not open this canvas.'))).toBe(false);
		expect(isMissingModuleError('Failed to fetch dynamically imported module')).toBe(false);
	});

	it('reloads once for a missing hashed chunk', () => {
		const reload = vi.fn();
		expect(reloadOnceForMissingModule(missing, 1_000, reload)).toBe(true);
		expect(reload).toHaveBeenCalledTimes(1);
		expect(sessionStorage.getItem(STALE_MODULE_RELOAD_KEY)).toBe('1000');
	});

	it('does not reload for other errors', () => {
		const reload = vi.fn();
		expect(
			reloadOnceForMissingModule(new Error('Could not open this canvas.'), 1_000, reload)
		).toBe(false);
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not loop if the new document still cannot fetch the module', () => {
		const reload = vi.fn();
		expect(reloadOnceForMissingModule(missing, 1_000, reload)).toBe(true);
		expect(
			reloadOnceForMissingModule(missing, 1_000 + STALE_MODULE_RELOAD_COOLDOWN_MS - 1, reload)
		).toBe(false);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('allows another reload after the cooldown', () => {
		const reload = vi.fn();
		expect(reloadOnceForMissingModule(missing, 1_000, reload)).toBe(true);
		expect(
			reloadOnceForMissingModule(missing, 1_000 + STALE_MODULE_RELOAD_COOLDOWN_MS, reload)
		).toBe(true);
		expect(reload).toHaveBeenCalledTimes(2);
	});
});
