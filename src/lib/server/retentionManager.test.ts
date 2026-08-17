import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionManager } from './retentionManager';
import { SyncStore } from './syncStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: SyncStore[] = [];
const directories: string[] = [];
const managers: RetentionManager[] = [];

function createStore(): SyncStore {
	const directory = mkdtempSync(join(tmpdir(), 'scraps-cache-retention-'));
	const store = new SyncStore(directory);
	directories.push(directory);
	stores.push(store);
	return store;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) manager.stop();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('RetentionManager', () => {
	it('stays disabled when inactive days are unset', async () => {
		const manager = new RetentionManager({ inactiveDays: 0, store: createStore() });
		managers.push(manager);
		expect(manager.getStatus()).toMatchObject({
			enabled: false,
			inactiveDays: 0,
			deletedAccountsTotal: 0
		});
		await expect(manager.runNow()).rejects.toThrow('Account retention is not configured');
	});

	it('deletes only stale accounts and logs counts without identifiers', async () => {
		const store = createStore();
		const now = 10 * 24 * 60 * 60 * 1000;
		store.createAccount('keep-account', 'credential', now);
		store.createAccount('drop-account', 'credential', 1);
		store.touchAccount('keep-account', now);
		store.touchAccount('drop-account', 1);
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const manager = new RetentionManager({
			inactiveDays: 1,
			store,
			now: () => now
		});
		managers.push(manager);

		const status = await manager.runNow();
		expect(status.enabled).toBe(true);
		expect(status.lastDeletedAccounts).toBe(1);
		expect(status.deletedAccountsTotal).toBe(1);
		expect(store.getCredentialHash('keep-account')).toBe('credential');
		expect(store.getCredentialHash('drop-account')).toBeNull();
		expect(info).toHaveBeenCalledOnce();
		const payload = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(payload).toMatchObject({
			event: 'retention_sweep',
			deletedAccounts: 1,
			inactiveDays: 1
		});
		expect(JSON.stringify(payload)).not.toContain('drop-account');
		expect(JSON.stringify(payload)).not.toContain('keep-account');
	});

	it('deletes every stale account in one daily sweep', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const store = createStore();
		store.createAccount('a', 'credential', 1);
		store.createAccount('b', 'credential', 2);
		store.createAccount('c', 'credential', 3);
		const manager = new RetentionManager({
			inactiveDays: 1,
			store,
			now: () => 1 + 2 * 24 * 60 * 60 * 1000
		});
		managers.push(manager);
		const status = await manager.runNow();
		expect(status.lastDeletedAccounts).toBe(3);
		expect(store.aggregateUsage().accounts).toBe(0);
	});
});
