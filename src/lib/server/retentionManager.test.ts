import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetentionManager } from './retentionManager';
import { DELETED_SLOT_GRACE_MS, SyncStore } from './syncStore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: SyncStore[] = [];
const directories: string[] = [];
const managers: RetentionManager[] = [];

function createStore(): SyncStore {
	const directory = mkdtempSync(join(tmpdir(), 'scrapscache-retention-'));
	const store = new SyncStore(directory);
	directories.push(directory);
	stores.push(store);
	return store;
}

function slot(character: string): string {
	return character.repeat(64);
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
	it('keeps purging expired slot deletions when account retention is unset', async () => {
		const store = createStore();
		store.createAccount('account', 'credential', 1);
		const uploaded = store.sync(
			'account',
			0,
			[{ id: 'photo', slot: slot('a'), ciphertext: 'opaque' }],
			[],
			10
		);
		store.sync('account', uploaded.cursor, [], [{ id: 'photo', slot: slot('a') }], 10);
		const sweepAt = Date.now() + DELETED_SLOT_GRACE_MS;
		const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const manager = new RetentionManager({ inactiveDays: 0, store, now: () => sweepAt });
		managers.push(manager);

		const status = await manager.runNow();
		expect(status.enabled).toBe(false);
		expect(status.lastDeletedAccounts).toBe(0);
		expect(status.lastPurgedSlots).toBe(1);
		expect(store.getAuthCredential('account')).toBe('credential');
		expect(info).toHaveBeenCalledOnce();
		const payload = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<string, unknown>;
		expect(payload).toMatchObject({
			event: 'retention_sweep',
			deletedAccounts: 0,
			purgedSlots: 1,
			inactiveDays: 0
		});
		expect(JSON.stringify(payload)).not.toContain('opaque');
		expect(JSON.stringify(payload)).not.toContain(slot('a'));
	});

	it('keeps recently deleted slots through a sweep while dropping stale accounts', async () => {
		vi.spyOn(console, 'info').mockImplementation(() => undefined);
		const store = createStore();
		const now = 10 * 24 * 60 * 60 * 1000;
		store.createAccount('fresh', 'credential', now);
		store.createAccount('stale', 'credential', 1);
		store.touchAccount('fresh', now);
		store.touchAccount('stale', 1);
		const uploaded = store.sync(
			'fresh',
			0,
			[{ id: 'photo', slot: slot('b'), ciphertext: 'opaque' }],
			[],
			10
		);
		store.sync('fresh', uploaded.cursor, [], [{ id: 'photo', slot: slot('b') }], 10);
		const manager = new RetentionManager({ inactiveDays: 1, store, now: () => now });
		managers.push(manager);

		const status = await manager.runNow();
		expect(status.lastDeletedAccounts).toBe(1);
		expect(status.lastPurgedSlots).toBe(0);
		expect(store.getAuthCredential('stale')).toBeNull();
		expect(store.aggregateUsage()).toMatchObject({ accounts: 1 });
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
		expect(store.getAuthCredential('keep-account')).toBe('credential');
		expect(store.getAuthCredential('drop-account')).toBeNull();
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
