import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SyncQuotaExceededError,
	SyncStore,
	DELETED_SLOT_GRACE_MS,
	WAKE_CLAIM_LEASE_MS
} from './syncStore';

const stores: SyncStore[] = [];
const directories: string[] = [];
const slot = (character: string) => character.repeat(64);
const wake = (character: string, fireAt: number) => ({ id: character.repeat(43), fireAt });

function createStore(options?: ConstructorParameters<typeof SyncStore>[1]): {
	store: SyncStore;
	directory: string;
} {
	const directory = mkdtempSync(join(tmpdir(), 'scrapscache-sync-'));
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
		expect(store.getAuthCredential('account')).toBe('first');
	});

	it('replaces an authentication credential only when the legacy value still matches', () => {
		const { store } = createStore();
		store.createAccount('account', 'legacy');
		expect(store.replaceAuthCredential('account', 'wrong', 'public-key')).toBe(false);
		expect(store.replaceAuthCredential('account', 'legacy', 'public-key')).toBe(true);
		expect(store.replaceAuthCredential('account', 'legacy', 'attacker-key')).toBe(false);
		expect(store.getAuthCredential('account')).toBe('public-key');
	});

	it('defaults each account to one GiB of ciphertext storage', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		expect(store.sync('account', 0, [], [], 1).usage.maxBytes).toBe(1024 ** 3);
	});

	it('enforces a durable per-account byte quota and can restore the default', () => {
		const { store, directory } = createStore({ maxAccountBytes: 100 });
		store.createAccount('limited-account', 'credential');
		store.createAccount('default-account', 'credential');

		expect(store.setAccountByteQuota('limited-account', 5)).toBe(true);
		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = new SyncStore(directory, { maxAccountBytes: 100 });
		stores.push(reopened);

		expect(reopened.getAccountByteQuota('limited-account')).toEqual({
			maxBytes: 5,
			overridden: true
		});
		expect(reopened.sync('limited-account', 0, [], [], 1).usage.maxBytes).toBe(5);
		expect(() =>
			reopened.sync(
				'limited-account',
				0,
				[{ id: 'too-large', slot: slot('a'), ciphertext: 'abcdef' }],
				[],
				1
			)
		).toThrow(SyncQuotaExceededError);
		expect(reopened.sync('default-account', 0, [], [], 1).usage.maxBytes).toBe(100);

		expect(reopened.clearAccountByteQuota('limited-account')).toBe(true);
		expect(reopened.getAccountByteQuota('limited-account')).toEqual({
			maxBytes: 100,
			overridden: false
		});
	});

	it('rejects invalid or nonexistent account quota overrides', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		expect(() => store.setAccountByteQuota('account', 0)).toThrow(RangeError);
		expect(() => store.setAccountByteQuota('account', Number.MAX_SAFE_INTEGER + 1)).toThrow(
			RangeError
		);
		expect(store.setAccountByteQuota('missing', 10)).toBe(false);
		expect(store.clearAccountByteQuota('missing')).toBe(false);
		expect(store.getAccountByteQuota('missing')).toBeNull();
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
		store.sync('account', 0, uploads, [], 600);
		let cursor = 0;
		let seen = 0;
		for (let page = 0; page < 60; page++) {
			const result = store.sync('account', cursor, [], [], 12);
			seen += result.envelopes.length;
			cursor = result.cursor;
			if (!result.hasMore) break;
		}
		expect(seen).toBe(600);
	});

	it('finishes paginated downloads before accepting simultaneous uploads', () => {
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
			[],
			10
		);

		const first = store.sync(
			'account',
			0,
			[{ id: 'mine', slot: slot('d'), ciphertext: 'local' }],
			[],
			2
		);
		expect(first.envelopes.map((envelope) => envelope.id)).toEqual(['a', 'b']);
		expect(first.hasMore).toBe(true);
		expect(first.cursor).toBe(2);
		expect(first.writesAccepted).toBe(false);

		const second = store.sync('account', first.cursor, [], [], 2);
		expect(second.envelopes.map((envelope) => envelope.id)).toEqual(['c']);
		expect(second.hasMore).toBe(false);
		expect(second.cursor).toBe(3);

		const uploaded = store.sync(
			'account',
			second.cursor,
			[{ id: 'mine', slot: slot('d'), ciphertext: 'local', expectedId: null }],
			[],
			2
		);
		expect(uploaded.writesAccepted).toBe(true);
		expect(store.sync('account', second.cursor, [], [], 2).envelopes.map(({ id }) => id)).toEqual([
			'mine'
		]);
	});

	it('keeps only the newest ciphertext in an opaque slot', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'old', slot: slot('a'), ciphertext: 'first' }], [], 10);
		store.sync(
			'account',
			1,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement', expectedId: 'old' }],
			[],
			10
		);

		const result = store.sync('account', 1, [], [], 10);
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
				[],
				10
			)
		).toThrow(SyncQuotaExceededError);

		expect(store.sync('account', 0, [], [], 10)).toMatchObject({
			cursor: 0,
			envelopes: [],
			hasMore: false
		});
	});

	it('does not impose a per-account record count quota', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		let result = store.sync('account', 0, [], [], 12);
		let cursor = result.cursor;
		for (let offset = 0; offset < 50_001; offset += 500) {
			const uploads = Array.from({ length: Math.min(500, 50_001 - offset) }, (_, index) => {
				const record = offset + index;
				return {
					id: `id-${record}`,
					slot: record.toString(16).padStart(64, '0'),
					ciphertext: 'a'
				};
			});
			result = store.sync('account', cursor, uploads, [], 12);
			cursor = result.cursor;
		}

		expect(result.usage).toMatchObject({ envelopeCount: 50_001, ciphertextBytes: 50_001 });
	});

	it('rolls back deletions together with an over-quota replacement batch', () => {
		const { store } = createStore({ maxAccountBytes: 5 });
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'kept', slot: slot('a'), ciphertext: '123' }], [], 10);

		expect(() =>
			store.sync(
				'account',
				1,
				[{ id: 'too-large', slot: slot('b'), ciphertext: '123456', expectedId: null }],
				[{ id: 'kept', slot: slot('a') }],
				10
			)
		).toThrow(SyncQuotaExceededError);
		expect(store.sync('account', 0, [], [], 10)).toMatchObject({
			envelopes: [expect.objectContaining({ id: 'kept' })],
			usage: expect.objectContaining({ envelopeCount: 1, ciphertextBytes: 3 })
		});
	});

	it('deletes only the expected opaque slot version and releases quota', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const first = store.sync(
			'account',
			0,
			[{ id: 'old', slot: slot('a'), ciphertext: 'first' }],
			[],
			10
		);
		expect(first.usage).toMatchObject({ envelopeCount: 1, ciphertextBytes: 5 });

		const replaced = store.sync(
			'account',
			first.cursor,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement', expectedId: 'old' }],
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

	it('hides deleted slots from downloads immediately but keeps their ciphertext during grace', () => {
		const { store, directory } = createStore();
		store.createAccount('account', 'credential');
		const uploaded = store.sync(
			'account',
			0,
			[
				{ id: 'note', slot: slot('a'), ciphertext: 'cipher-note' },
				{ id: 'photo', slot: slot('b'), ciphertext: 'cipher-photo' }
			],
			[],
			10
		);

		const removed = store.sync(
			'account',
			uploaded.cursor,
			[],
			[{ id: 'photo', slot: slot('b') }],
			10
		);
		expect(removed.usage).toMatchObject({
			envelopeCount: 1,
			ciphertextBytes: 'cipher-note'.length
		});

		// A slower device rewinding behind the deletion never sees the slot again.
		expect(store.sync('account', 0, [], [], 10).envelopes.map(({ id }) => id)).toEqual(['note']);

		const raw = new Database(join(directory, 'sync.sqlite'));
		try {
			expect(
				raw
					.prepare('SELECT id, ciphertext FROM deleted_envelopes WHERE account_id = ? AND slot = ?')
					.get('account', slot('b'))
			).toEqual({ id: 'photo', ciphertext: 'cipher-photo' });
		} finally {
			raw.close();
		}
	});

	it('purges staged slot deletions only after the grace window', () => {
		const { store, directory } = createStore();
		store.createAccount('account', 'credential');
		const uploaded = store.sync(
			'account',
			0,
			[{ id: 'photo', slot: slot('a'), ciphertext: 'opaque' }],
			[],
			10
		);
		store.sync('account', uploaded.cursor, [], [{ id: 'photo', slot: slot('a') }], 10);

		const raw = new Database(join(directory, 'sync.sqlite'));
		const { deletedAt } = raw
			.prepare('SELECT deleted_at AS deletedAt FROM deleted_envelopes')
			.get() as { deletedAt: number };
		raw.close();

		expect(store.purgeExpiredDeletedEnvelopes(deletedAt + DELETED_SLOT_GRACE_MS - 1)).toBe(0);
		expect(store.purgeExpiredDeletedEnvelopes(deletedAt + DELETED_SLOT_GRACE_MS)).toBe(1);
	});

	it('returns the current slot and rejects a stale conditional replacement', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'current', slot: slot('a'), ciphertext: 'remote' }], [], 10);

		const stale = store.sync(
			'account',
			1,
			[{ id: 'stale', slot: slot('a'), ciphertext: 'local', expectedId: 'older' }],
			[],
			10
		);
		expect(stale).toMatchObject({
			writesAccepted: false,
			conflicts: [{ id: 'current', slot: slot('a'), ciphertext: 'remote', seq: 1 }]
		});
		expect(store.sync('account', 0, [], [], 10).envelopes.map(({ id }) => id)).toEqual(['current']);
	});

	it('rejects an entire mixed batch when any conditional replacement conflicts', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync(
			'account',
			0,
			[
				{ id: 'current-a', slot: slot('a'), ciphertext: 'a' },
				{ id: 'current-b', slot: slot('b'), ciphertext: 'b' }
			],
			[],
			10
		);

		const rejected = store.sync(
			'account',
			2,
			[
				{ id: 'stale-a', slot: slot('a'), ciphertext: 'stale', expectedId: 'older-a' },
				{ id: 'fresh-c', slot: slot('c'), ciphertext: 'fresh', expectedId: null }
			],
			[{ id: 'current-b', slot: slot('b') }],
			10
		);

		expect(rejected).toMatchObject({ writesAccepted: false, usage: { envelopeCount: 2 } });
		expect(store.sync('account', 0, [], [], 10).envelopes.map(({ id }) => id)).toEqual([
			'current-a',
			'current-b'
		]);
	});

	it('treats an identical envelope id retry as an idempotent acknowledgement', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const upload = { id: 'same-id', slot: slot('a'), ciphertext: 'opaque', expectedId: null };
		const first = store.sync('account', 0, [upload], [], 10);
		const retry = store.sync('account', first.cursor, [upload], [], 10);

		expect(retry).toMatchObject({ cursor: 1, writesAccepted: true });
		expect(retry.usage).toMatchObject({ envelopeCount: 1, ciphertextBytes: 6 });
	});

	it('advances across sequence gaps left by current-state deletion', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'old', slot: slot('a'), ciphertext: 'old' }], [], 10);
		store.sync(
			'account',
			1,
			[{ id: 'new', slot: slot('a'), ciphertext: 'new', expectedId: 'old' }],
			[],
			10
		);
		store.sync('account', 2, [], [{ id: 'new', slot: slot('a') }], 10);

		expect(store.sync('account', 1, [], [], 10)).toMatchObject({
			cursor: 2,
			envelopes: [],
			hasMore: false
		});
	});

	it('does not overwrite the thirteenth remote slot before the client reads it', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const remote = Array.from({ length: 13 }, (_, index) => ({
			id: `remote-${index + 1}`,
			slot: index.toString(16).padStart(64, '0'),
			ciphertext: `cipher-${index + 1}`
		}));
		store.sync('account', 0, remote, [], 20);

		const first = store.sync(
			'account',
			0,
			[
				{
					id: 'stale-thirteen',
					slot: remote[12].slot,
					ciphertext: 'stale',
					expectedId: null
				}
			],
			[],
			12
		);
		expect(first.envelopes).toHaveLength(12);
		expect(first.writesAccepted).toBe(false);
		const second = store.sync('account', first.cursor, [], [], 12);
		expect(second.envelopes.map(({ id }) => id)).toEqual(['remote-13']);
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

	it('re-claims an undelivered wake after the claim lease expires', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		store.replaceReminderWakes('account', [wake('a', 1_000)]);
		const [claimed] = store.claimDueWakes(1_000);
		expect(store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS - 1)).toEqual([]);
		const reclaimed = store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]).toMatchObject({ accountId: 'account', wakeId: wake('a', 1_000).id });
		store.markWakeDelivered(reclaimed[0], 1_000 + WAKE_CLAIM_LEASE_MS);
		expect(store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS)).toEqual([]);
	});

	it('moves an endpoint or device registration when another account claims it', () => {
		const { store } = createStore();
		store.createAccount('old-owner', 'credential-old');
		store.createAccount('new-owner', 'credential-new');
		const keys = { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) };
		store.savePushDevice({
			accountId: 'old-owner',
			deviceId: 'device-old00000000',
			endpoint: 'https://push.example/endpoint-a',
			...keys
		});
		store.savePushDevice({
			accountId: 'new-owner',
			deviceId: 'device-new00000000',
			endpoint: 'https://push.example/endpoint-b',
			...keys
		});
		// A re-registered endpoint under a different account steals it from the old row.
		store.savePushDevice({
			accountId: 'new-owner',
			deviceId: 'device-replaced000',
			endpoint: 'https://push.example/endpoint-a',
			...keys
		});
		// A re-registered device id under a different account moves the whole row.
		store.savePushDevice({
			accountId: 'old-owner',
			deviceId: 'device-new00000000',
			endpoint: 'https://push.example/endpoint-c',
			...keys
		});
		expect(store.countPushDevices('old-owner')).toBe(1);
		expect(store.countPushDevices('new-owner')).toBe(1);
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

	it('treats an identical mixed-case wake snapshot as a no-op at the same revision', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		const wakes = [
			{ id: `B${'x'.repeat(42)}`, fireAt: 1_000 },
			{ id: `a${'x'.repeat(42)}`, fireAt: 2_000 }
		];
		expect(store.replaceReminderWakes('account', wakes, 5)).toBe(true);
		expect(store.replaceReminderWakes('account', [...wakes].reverse(), 5)).toBe(true);
	});

	it('rejects stale reminder snapshots and retains delivery receipts across omission', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		const reminder = wake('a', 1_000);
		expect(store.replaceReminderWakes('account', [reminder], 5)).toBe(true);
		expect(store.replaceReminderWakes('account', [], 5)).toBe(false);
		const [claimed] = store.claimDueWakes(1_000);
		store.markWakeDelivered(claimed, 1_000);

		expect(store.replaceReminderWakes('account', [], 4)).toBe(false);
		expect(store.listWakeTimes('account')).toEqual([1_000]);
		expect(store.replaceReminderWakes('account', [], 6)).toBe(true);
		expect(store.replaceReminderWakes('account', [reminder], 7)).toBe(true);
		expect(store.claimDueWakes(1_000)).toEqual([]);
	});

	it('does not schedule a wake time for wakes with no deliverable device', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.replaceReminderWakes('account', [wake('a', 5_000)]);
		expect(store.nextWakeAt(1_000)).toBeNull();
	});

	it('ignores delivered wakes when projecting the next fire time', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		store.replaceReminderWakes('account', [wake('a', 1_000), wake('b', 2_000)]);
		const [claimed] = store.claimDueWakes(1_000);
		store.markWakeDelivered(claimed, 1_000);
		expect(store.nextWakeAt(1_000)).toBe(2_000);

		store.releaseWakeClaim(claimed);
		expect(store.nextWakeAt(1_000)).toBe(2_000);
	});

	it('rejects uploads whose ciphertext is not base64url', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		expect(() =>
			store.sync(
				'account',
				0,
				[{ id: 'bad', slot: slot('a'), ciphertext: 'not+base64url/chars' }],
				[],
				10
			)
		).toThrow(/base64url/);
		expect(store.sync('account', 0, [], [], 10).usage.envelopeCount).toBe(0);
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

	it('counts anonymous activity windows and deletes only stale accounts', () => {
		const { store } = createStore();
		const now = 60 * 24 * 60 * 60 * 1000;
		store.createAccount('fresh', 'credential', now);
		store.createAccount('week-old', 'credential', now - 8 * 24 * 60 * 60 * 1000);
		store.createAccount('stale', 'credential', 1);
		store.sync('fresh', 0, [{ id: 'note', slot: slot('a'), ciphertext: 'opaque' }], [], 10);
		store.touchAccount('fresh', now);
		store.touchAccount('week-old', now - 8 * 24 * 60 * 60 * 1000);
		store.touchAccount('stale', 1);

		expect(
			store.operatorUsage({
				now,
				staleBefore: now - 20 * 24 * 60 * 60 * 1000
			})
		).toEqual({
			accounts: 3,
			envelopeCount: 1,
			ciphertextBytes: 'opaque'.length,
			activeByWindowDays: { '1': 1, '7': 1, '30': 2 },
			staleAccounts: 1
		});

		expect(store.deleteInactiveAccounts(now - 20 * 24 * 60 * 60 * 1000)).toBe(1);
		expect(store.getAuthCredential('stale')).toBeNull();
		expect(store.getAuthCredential('fresh')).toBe('credential');
		expect(store.getAuthCredential('week-old')).toBe('credential');
	});

	it('treats pull-only sync as activity without changing stored ciphertext', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential', 1);
		store.touchAccount('account', 1);
		store.sync('account', 0, [], [], 10);
		expect(store.deleteInactiveAccounts(Date.now() - 1_000)).toBe(0);
		expect(store.getAuthCredential('account')).toBe('credential');
		expect(store.aggregateUsage()).toEqual({
			accounts: 1,
			envelopeCount: 0,
			ciphertextBytes: 0
		});
	});

	it('resets a cursor that is ahead of a restored relay sequence', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }], [], 10);

		expect(store.sync('account', 50, [], [], 10)).toMatchObject({
			cursor: 0,
			reset: true,
			writesAccepted: false
		});
	});

	it('deletes an account and all of its opaque envelopes', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }], [], 10);
		store.savePushDevice({
			accountId: 'account',
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/account',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16)
		});
		store.replaceReminderWakes('account', [wake('a', 1_000)]);
		expect(store.deleteAccount('account')).toBe(true);
		expect(store.getAuthCredential('account')).toBeNull();
		expect(store.countPushDevices()).toBe(0);
		expect(store.listWakeTimes('account')).toEqual([]);
		expect(store.aggregateUsage()).toEqual({
			accounts: 0,
			envelopeCount: 0,
			ciphertextBytes: 0
		});
	});
});
