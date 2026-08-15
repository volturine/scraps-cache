import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncQuotaExceededError, SyncStore } from './syncStore';

const stores: SyncStore[] = [];
const directories: string[] = [];
const slot = (character: string) => character.repeat(64);
const wake = (character: string, fireAt: number) => ({ id: character.repeat(43), fireAt });

function createStore(options?: ConstructorParameters<typeof SyncStore>[1]): {
	store: SyncStore;
	directory: string;
} {
	const directory = mkdtempSync(join(tmpdir(), 'shard-sync-'));
	const store = new SyncStore(directory, options);
	directories.push(directory);
	stores.push(store);
	return { store, directory };
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('SQLite sync store', () => {
	it('creates accounts without overwriting existing credentials', () => {
		const { store } = createStore();
		expect(store.createAccount('account', 'first')).toBe(true);
		expect(store.createAccount('account', 'second')).toBe(false);
		expect(store.getCredentialHash('account')).toBe('first');
	});

	it('pages more than 480 envelopes without dropping the tail', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const uploads = Array.from({ length: 600 }, (_, index) => ({
			id: `id-${index}`,
			slot: slot(index.toString(16).padStart(1, 'a').repeat(1)).slice(0, 64).padEnd(64, 'a'),
			ciphertext: `c${index}`
		}));
		// Unique slots: hash-like 64 hex from index
		for (const [index, upload] of uploads.entries()) {
			upload.slot = index.toString(16).padStart(64, '0');
		}
		store.sync('account', 0, uploads, 600);
		let cursor = 0;
		let seen = 0;
		for (let page = 0; page < 60; page++) {
			const result = store.sync('account', cursor, [], 12);
			seen += result.envelopes.length;
			cursor = result.cursor;
			if (!result.hasMore) break;
		}
		expect(seen).toBe(600);
	});

	it('paginates existing data without skipping simultaneous uploads', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync(
			'account',
			0,
			[
				{ id: 'a', slot: slot('a'), ciphertext: 'a' },
				{ id: 'b', slot: slot('b'), ciphertext: 'b' },
				{ id: 'c', slot: slot('c'), ciphertext: 'c' }
			],
			10
		);

		const first = store.sync(
			'account',
			0,
			[{ id: 'mine', slot: slot('d'), ciphertext: 'local' }],
			2
		);
		expect(first.envelopes.map((envelope) => envelope.id)).toEqual(['a', 'b']);
		expect(first.hasMore).toBe(true);
		expect(first.cursor).toBe(2);

		const second = store.sync('account', first.cursor, [], 2);
		expect(second.envelopes.map((envelope) => envelope.id)).toEqual(['c', 'mine']);
		expect(second.hasMore).toBe(false);
		expect(second.cursor).toBe(4);
	});

	it('keeps only the newest ciphertext in an opaque slot', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'old', slot: slot('a'), ciphertext: 'first' }], 10);
		store.sync('account', 1, [{ id: 'new', slot: slot('a'), ciphertext: 'replacement' }], 10);

		const result = store.sync('account', 1, [], 10);
		expect(result.envelopes).toEqual([
			{ seq: 2, id: 'new', slot: slot('a'), ciphertext: 'replacement' }
		]);
	});

	it('rolls back the entire upload batch when an account quota is exceeded', () => {
		const { store } = createStore({ maxAccountBytes: 5 });
		store.createAccount('account', 'credential');
		expect(() =>
			store.sync(
				'account',
				0,
				[
					{ id: 'a', slot: slot('a'), ciphertext: '123' },
					{ id: 'b', slot: slot('b'), ciphertext: '456' }
				],
				10
			)
		).toThrow(SyncQuotaExceededError);

		expect(store.sync('account', 0, [], 10)).toMatchObject({
			cursor: 0,
			envelopes: [],
			hasMore: false
		});
	});

	it('deletes only the expected opaque slot version and releases quota', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const first = store.sync(
			'account',
			0,
			[{ id: 'old', slot: slot('a'), ciphertext: 'first' }],
			10
		);
		expect(first.usage).toMatchObject({ envelopeCount: 1, ciphertextBytes: 5 });

		const replaced = store.sync(
			'account',
			first.cursor,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement' }],
			[],
			10
		);
		const staleDelete = store.sync(
			'account',
			replaced.cursor,
			[],
			[{ id: 'old', slot: slot('a') }],
			10
		);
		expect(staleDelete.usage.envelopeCount).toBe(1);

		const removed = store.sync(
			'account',
			staleDelete.cursor,
			[],
			[{ id: 'new', slot: slot('a') }],
			10
		);
		expect(removed.usage).toMatchObject({ envelopeCount: 0, ciphertextBytes: 0 });
	});

	it('stores and claims opaque reminder wakes independently by id', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		store.replaceReminderWakes('account', [wake('b', 5_000), wake('a', 1_000), wake('c', 9_000)]);
		expect(store.listWakeTimes('account')).toEqual([1_000, 5_000, 9_000]);
		const claimed = store.claimDueWakes(1_000);
		expect(claimed).toEqual([
			expect.objectContaining({
				accountId: 'account',
				deviceId: 'device-aaaaaaaaaaaa',
				wakeId: 'a'.repeat(43),
				fireAt: 1_000
			})
		]);
		expect(store.claimDueWakes(1_000)).toEqual([]);
		store.markWakeDelivered(claimed[0], 1_000);
		expect(store.claimDueWakes(1_000)).toEqual([]);
		expect(store.nextWakeAt(1_000)).toBe(5_000);
	});

	it('fans each account wake out once to every registered device', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice({
			deviceId: 'device-phone000000',
			endpoint: 'https://push.example/phone',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		store.savePushDevice({
			deviceId: 'device-tablet00000',
			endpoint: 'https://push.example/tablet',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		store.replaceReminderWakes('account', [wake('a', 1_000)]);
		const claimed = store.claimDueWakes(1_000);
		expect(claimed.map((device) => device.deviceId).sort()).toEqual([
			'device-phone000000',
			'device-tablet00000'
		]);
		for (const delivery of claimed) store.markWakeDelivered(delivery, 1_000);
		expect(store.claimDueWakes(1_000)).toEqual([]);
	});

	it('keeps account wakes separate from registration and replaces them authoritatively', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.replaceReminderWakes('account', [wake('a', 1_000)]);
		store.savePushDevice({
			deviceId: 'device-empty000000',
			endpoint: 'https://push.example/empty',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		expect(store.listWakeTimes('account')).toEqual([1_000]);
		store.replaceReminderWakes('account', [wake('b', 2_000)]);
		expect(store.listWakeTimes('account')).toEqual([2_000]);
	});

	it('keeps at most 32 push devices per account', () => {
		const { store } = createStore();
		store.createAccount('account-a', 'credential-a');
		store.createAccount('account-b', 'credential-b');
		for (let index = 0; index < 33; index++) {
			store.savePushDevice({
				accountId: 'account-a',
				deviceId: `device-${String(index).padStart(12, '0')}`,
				endpoint: `https://push.example/sub-${index}`,
				p256dh: 'p'.repeat(20),
				auth: 'a'.repeat(16)
			});
		}
		store.savePushDevice({
			accountId: 'account-b',
			deviceId: 'device-other000000',
			endpoint: 'https://push.example/other',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16)
		});
		expect(store.countPushDevices('account-a')).toBe(32);
		expect(store.countPushDevices('account-b')).toBe(1);
		expect(store.countPushDevices()).toBe(33);
	});

	it('deletes an account and all of its opaque envelopes', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }], 10);
		store.savePushDevice({
			accountId: 'account',
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/account',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16)
		});
		store.replaceReminderWakes('account', [wake('a', 1_000)]);
		expect(store.deleteAccount('account')).toBe(true);
		expect(store.getCredentialHash('account')).toBeNull();
		expect(store.countPushDevices()).toBe(0);
		expect(store.listWakeTimes('account')).toEqual([]);
		expect(store.aggregateUsage()).toEqual({
			accounts: 0,
			envelopeCount: 0,
			ciphertextBytes: 0
		});
	});

	it('imports the legacy JSON once and leaves it available for recovery', () => {
		const directory = mkdtempSync(join(tmpdir(), 'shard-sync-'));
		directories.push(directory);
		const legacyFile = join(directory, 'users.json');
		const legacy = JSON.stringify({
			account: {
				credentialHash: 'credential',
				nextSeq: 7,
				updatedAt: 123,
				envelopes: [
					{ seq: 2, id: 'old', slot: slot('a'), ciphertext: 'old' },
					{ seq: 7, id: 'new', slot: slot('a'), ciphertext: 'new' }
				]
			}
		});
		writeFileSync(legacyFile, legacy);

		const store = new SyncStore(directory);
		stores.push(store);
		expect(store.getCredentialHash('account')).toBe('credential');
		expect(store.sync('account', 0, [], 10).envelopes).toEqual([
			{ seq: 7, id: 'new', slot: slot('a'), ciphertext: 'new' }
		]);
		expect(readFileSync(legacyFile, 'utf8')).toBe(legacy);
	});

	it('online-backup snapshot restores credentials and opaque envelopes', async () => {
		const { store } = createStore();
		store.createAccount('account', 'restore-credential');
		store.sync(
			'account',
			0,
			[
				{ id: 'note-1', slot: slot('a'), ciphertext: 'cipher-a' },
				{ id: 'note-2', slot: slot('b'), ciphertext: 'cipher-b' }
			],
			10
		);

		const snapshotDirectory = mkdtempSync(join(tmpdir(), 'shard-snapshot-'));
		directories.push(snapshotDirectory);
		const snapshotPath = join(snapshotDirectory, 'snapshot.sqlite');
		await store.backup(snapshotPath);

		// Later live writes must not appear in the already-taken snapshot.
		store.sync('account', 2, [{ id: 'note-3', slot: slot('c'), ciphertext: 'cipher-c' }], 10);

		const restoredDirectory = mkdtempSync(join(tmpdir(), 'shard-restored-'));
		directories.push(restoredDirectory);
		copyFileSync(snapshotPath, join(restoredDirectory, 'sync.sqlite'));
		const restored = new SyncStore(restoredDirectory);
		stores.push(restored);

		expect(restored.getCredentialHash('account')).toBe('restore-credential');
		expect(restored.sync('account', 0, [], 10)).toMatchObject({
			cursor: 2,
			hasMore: false,
			envelopes: [
				{ seq: 1, id: 'note-1', slot: slot('a'), ciphertext: 'cipher-a' },
				{ seq: 2, id: 'note-2', slot: slot('b'), ciphertext: 'cipher-b' }
			]
		});
		expect(restored.aggregateUsage()).toEqual({
			accounts: 1,
			envelopeCount: 2,
			ciphertextBytes: 'cipher-a'.length + 'cipher-b'.length
		});
	});
});
