import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from './backupManager';
import { SyncStore } from './syncStore';

const stores: SyncStore[] = [];
const directories: string[] = [];
const managers: BackupManager[] = [];
const slot = (character: string) => character.repeat(64);

function tempDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

function createStore(): SyncStore {
	const store = new SyncStore(tempDirectory('scraps-cache-sync-'));
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('BackupManager', () => {
	it('rejects runNow when backups are not configured', async () => {
		const manager = new BackupManager({ directory: '' });
		managers.push(manager);
		await expect(manager.runNow()).rejects.toThrow('Server backups are not configured');
		expect(manager.getStatus()).toMatchObject({
			enabled: false,
			failures: 0,
			lastFile: null
		});
	});

	it('writes a verified snapshot that restores into a fresh SyncStore', async () => {
		const store = createStore();
		store.createAccount('account', 'credential-hash');
		store.sync('account', 0, [{ id: 'env-1', slot: slot('a'), ciphertext: 'opaque-payload' }], 10);

		const backupDirectory = tempDirectory('scraps-cache-backups-');
		const manager = new BackupManager({
			directory: backupDirectory,
			retain: 2,
			source: store
		});
		managers.push(manager);

		const status = await manager.runNow();
		expect(status.enabled).toBe(true);
		expect(status.failures).toBe(0);
		expect(status.lastError).toBeNull();
		expect(status.lastFile).toMatch(/[/\\]scraps-cache-sync-.*\.sqlite$/);
		expect(existsSync(status.lastFile!)).toBe(true);
		const leftoverTemps = readdirSync(backupDirectory).filter((name) =>
			name.startsWith('.scraps-cache-sync-')
		);
		expect(leftoverTemps).toEqual([]);

		const restoredDirectory = tempDirectory('scraps-cache-restored-');
		copyFileSync(status.lastFile!, join(restoredDirectory, 'sync.sqlite'));
		const restored = new SyncStore(restoredDirectory);
		stores.push(restored);

		expect(restored.getCredentialHash('account')).toBe('credential-hash');
		expect(restored.sync('account', 0, [], 10).envelopes).toEqual([
			{ seq: 1, id: 'env-1', slot: slot('a'), ciphertext: 'opaque-payload' }
		]);
	});

	it('prunes older snapshots beyond the retention count', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		const backupDirectory = tempDirectory('scraps-cache-backups-');
		const manager = new BackupManager({
			directory: backupDirectory,
			retain: 2,
			source: store
		});
		managers.push(manager);

		for (let index = 0; index < 3; index += 1) {
			await manager.runNow();
			// Ensure ISO timestamps in filenames are unique across rapid runs.
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		const snapshots = readdirSync(backupDirectory)
			.filter((name) => /^scraps-cache-sync-.*\.sqlite$/.test(name))
			.sort();
		expect(snapshots).toHaveLength(2);
		expect(manager.getStatus().lastFile).toBe(join(backupDirectory, snapshots.at(-1)!));
	});

	it('does not start a second backup while one is already running', async () => {
		const store = createStore();
		const backupDirectory = tempDirectory('scraps-cache-backups-');
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let backupCalls = 0;

		const manager = new BackupManager({
			directory: backupDirectory,
			source: {
				async backup(destination) {
					backupCalls += 1;
					await gate;
					await store.backup(destination);
				}
			}
		});
		managers.push(manager);

		const first = manager.runNow();
		// Allow the first call to mark itself running before the second call.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.getStatus().running).toBe(true);

		const overlapping = await manager.runNow();
		expect(overlapping.running).toBe(true);
		expect(backupCalls).toBe(1);

		release();
		const finished = await first;
		expect(finished.running).toBe(false);
		expect(finished.failures).toBe(0);
		expect(backupCalls).toBe(1);
	});

	it('cleans temporary files and records failures when verification fails', async () => {
		const backupDirectory = tempDirectory('scraps-cache-backups-');
		const manager = new BackupManager({
			directory: backupDirectory,
			source: {
				async backup(destination) {
					writeFileSync(destination, 'not-a-sqlite-database');
				}
			}
		});
		managers.push(manager);

		await expect(manager.runNow()).rejects.toThrow();
		expect(manager.getStatus()).toMatchObject({
			failures: 1,
			lastFile: null,
			running: false
		});
		expect(manager.getStatus().lastError).toBeTruthy();
		expect(readdirSync(backupDirectory)).toEqual([]);
	});
});
