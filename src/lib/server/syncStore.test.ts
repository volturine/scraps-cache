import { afterEach, describe, expect, it } from 'vitest';
import {
	SyncQuotaExceededError,
	SyncStore,
	DELETED_SLOT_GRACE_MS,
	ENVELOPE_STORAGE_OVERHEAD_BYTES,
	WAKE_CLAIM_LEASE_MS
} from './syncStore';
import { testDb, cleanupTestDbs } from './testDb';
import type { Db } from './db';

const slot = (character: string) => character.repeat(64);
const wake = (character: string, fireAt: number) => ({ id: character.repeat(43), fireAt });

afterEach(() => cleanupTestDbs());

function createStore(options?: ConstructorParameters<typeof SyncStore>[1]): {
	store: SyncStore;
	db: Db;
} {
	const db = testDb();
	const store = new SyncStore(db, options);
	return { store, db };
}

describe('SQLite sync store', () => {
	it('creates accounts without overwriting existing credentials', async () => {
		const { store } = createStore();
		expect(await store.createAccount('account', 'first')).toBe(true);
		expect(await store.createAccount('account', 'second')).toBe(false);
		expect(await store.getAuthCredential('account')).toBe('first');
	});

	it('replaces an authentication credential only when the legacy value still matches', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'legacy');
		expect(await store.replaceAuthCredential('account', 'wrong', 'public-key')).toBe(false);
		expect(await store.replaceAuthCredential('account', 'legacy', 'public-key')).toBe(true);
		expect(await store.replaceAuthCredential('account', 'legacy', 'attacker-key')).toBe(false);
		expect(await store.getAuthCredential('account')).toBe('public-key');
	});

	it('defaults each account to 1000 MB of estimated relay storage', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		expect((await store.sync('account', 0, [], [], 1)).usage.maxBytes).toBe(1_000_000_000);
	});

	it('enforces a durable per-account byte quota and can restore the default', async () => {
		const defaultQuota = ENVELOPE_STORAGE_OVERHEAD_BYTES + 100;
		const limitedQuota = ENVELOPE_STORAGE_OVERHEAD_BYTES + 5;
		const db = testDb();
		const store = new SyncStore(db, { maxAccountBytes: defaultQuota });
		await store.createAccount('limited-account', 'credential');
		await store.createAccount('default-account', 'credential');

		expect(await store.setAccountByteQuota('limited-account', limitedQuota)).toBe(true);
		const reopened = new SyncStore(db, { maxAccountBytes: defaultQuota });

		expect(await reopened.getAccountByteQuota('limited-account')).toEqual({
			maxBytes: limitedQuota,
			overridden: true
		});
		expect((await reopened.sync('limited-account', 0, [], [], 1)).usage.maxBytes).toBe(
			limitedQuota
		);
		await expect(
			reopened.sync(
				'limited-account',
				0,
				[{ id: 'too-large', slot: slot('a'), ciphertext: 'abcdef' }],
				[],
				1
			)
		).rejects.toThrow(SyncQuotaExceededError);
		expect((await reopened.sync('default-account', 0, [], [], 1)).usage.maxBytes).toBe(
			defaultQuota
		);

		expect(await reopened.clearAccountByteQuota('limited-account')).toBe(true);
		expect(await reopened.getAccountByteQuota('limited-account')).toEqual({
			maxBytes: defaultQuota,
			overridden: false
		});
	});

	it('rejects invalid or nonexistent account quota overrides', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await expect(store.setAccountByteQuota('account', 0)).rejects.toThrow(RangeError);
		await expect(store.setAccountByteQuota('account', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(
			RangeError
		);
		expect(await store.setAccountByteQuota('missing', 10)).toBe(false);
		expect(await store.clearAccountByteQuota('missing')).toBe(false);
		expect(await store.getAccountByteQuota('missing')).toBeNull();
	});

	it('pages more than 480 envelopes without dropping the tail', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		const uploads = Array.from({ length: 600 }, (_, index) => ({
			id: `id-${index}`,
			slot: slot(index.toString(16).padStart(1, 'a').repeat(1)).slice(0, 64).padEnd(64, 'a'),
			ciphertext: `c${index}`
		}));
		// Unique slots: hash-like 64 hex from index
		for (const [index, upload] of uploads.entries()) {
			upload.slot = index.toString(16).padStart(64, '0');
		}
		await store.sync('account', 0, uploads, [], 600);
		let cursor = 0;
		let seen = 0;
		for (let page = 0; page < 60; page++) {
			const result = await store.sync('account', cursor, [], [], 12);
			seen += result.envelopes.length;
			cursor = result.cursor;
			if (!result.hasMore) break;
		}
		expect(seen).toBe(600);
	});

	it('finishes paginated downloads before accepting simultaneous uploads', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync(
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

		const first = await store.sync(
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

		const second = await store.sync('account', first.cursor, [], [], 2);
		expect(second.envelopes.map((envelope) => envelope.id)).toEqual(['c']);
		expect(second.hasMore).toBe(false);
		expect(second.cursor).toBe(3);

		const uploaded = await store.sync(
			'account',
			second.cursor,
			[{ id: 'mine', slot: slot('d'), ciphertext: 'local', expectedId: null }],
			[],
			2
		);
		expect(uploaded.writesAccepted).toBe(true);
		expect(
			(await store.sync('account', second.cursor, [], [], 2)).envelopes.map(({ id }) => id)
		).toEqual(['mine']);
	});

	it('keeps only the newest ciphertext in an opaque slot', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync('account', 0, [{ id: 'old', slot: slot('a'), ciphertext: 'first' }], [], 10);
		await store.sync(
			'account',
			1,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement', expectedId: 'old' }],
			[],
			10
		);

		const result = await store.sync('account', 1, [], [], 10);
		expect(result.envelopes).toEqual([
			{ seq: 2, id: 'new', slot: slot('a'), ciphertext: 'replacement' }
		]);
	});

	it('rolls back the entire upload batch when an account quota is exceeded', async () => {
		const { store } = createStore({
			maxAccountBytes: ENVELOPE_STORAGE_OVERHEAD_BYTES + 5
		});
		await store.createAccount('account', 'credential');
		await expect(
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
		).rejects.toThrow(SyncQuotaExceededError);

		expect(await store.sync('account', 0, [], [], 10)).toMatchObject({
			cursor: 0,
			envelopes: [],
			hasMore: false
		});
	});

	it('does not impose a per-account record count quota', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		let result = await store.sync('account', 0, [], [], 12);
		let cursor = result.cursor;
		const total = 2_001;
		for (let offset = 0; offset < total; offset += 500) {
			const uploads = Array.from({ length: Math.min(500, total - offset) }, (_, index) => {
				const record = offset + index;
				return {
					id: `id-${record}`,
					slot: record.toString(16).padStart(64, '0'),
					ciphertext: 'a'
				};
			});
			result = await store.sync('account', cursor, uploads, [], 12);
			cursor = result.cursor;
		}

		expect(result.usage).toMatchObject({ envelopeCount: total, ciphertextBytes: total });
	});

	it('rolls back deletions together with an over-quota replacement batch', async () => {
		const { store } = createStore({
			maxAccountBytes: ENVELOPE_STORAGE_OVERHEAD_BYTES + 5
		});
		await store.createAccount('account', 'credential');
		await store.sync('account', 0, [{ id: 'kept', slot: slot('a'), ciphertext: '123' }], [], 10);

		await expect(
			store.sync(
				'account',
				1,
				[{ id: 'too-large', slot: slot('b'), ciphertext: '123456', expectedId: null }],
				[{ id: 'kept', slot: slot('a') }],
				10
			)
		).rejects.toThrow(SyncQuotaExceededError);
		expect(await store.sync('account', 0, [], [], 10)).toMatchObject({
			envelopes: [expect.objectContaining({ id: 'kept' })],
			usage: expect.objectContaining({ envelopeCount: 1, ciphertextBytes: 3 })
		});
	});

	it('deletes only the expected opaque slot version and releases quota', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		const first = await store.sync(
			'account',
			0,
			[{ id: 'old', slot: slot('a'), ciphertext: 'first' }],
			[],
			10
		);
		expect(first.usage).toMatchObject({ envelopeCount: 1, ciphertextBytes: 5 });

		const replaced = await store.sync(
			'account',
			first.cursor,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement', expectedId: 'old' }],
			[],
			10
		);
		const staleDelete = await store.sync(
			'account',
			replaced.cursor,
			[],
			[{ id: 'old', slot: slot('a') }],
			10
		);
		expect(staleDelete.usage.envelopeCount).toBe(1);

		const removed = await store.sync(
			'account',
			staleDelete.cursor,
			[],
			[{ id: 'new', slot: slot('a') }],
			10
		);
		expect(removed.usage).toMatchObject({ envelopeCount: 0, ciphertextBytes: 0 });
		expect(removed.usage.storageBytes).toBe(ENVELOPE_STORAGE_OVERHEAD_BYTES + 'replacement'.length);
	});

	it('hides deleted slots from downloads immediately but keeps their ciphertext during grace', async () => {
		const { store, db } = createStore();
		await store.createAccount('account', 'credential');
		const uploaded = await store.sync(
			'account',
			0,
			[
				{ id: 'note', slot: slot('a'), ciphertext: 'cipher-note' },
				{ id: 'photo', slot: slot('b'), ciphertext: 'cipher-photo' }
			],
			[],
			10
		);

		const removed = await store.sync(
			'account',
			uploaded.cursor,
			[],
			[{ id: 'photo', slot: slot('b') }],
			10
		);
		expect(removed.usage).toMatchObject({
			envelopeCount: 1,
			ciphertextBytes: 'cipher-note'.length,
			storageBytes:
				2 * ENVELOPE_STORAGE_OVERHEAD_BYTES + 'cipher-note'.length + 'cipher-photo'.length
		});

		// A slower device rewinding behind the deletion never sees the slot again.
		expect((await store.sync('account', 0, [], [], 10)).envelopes.map(({ id }) => id)).toEqual([
			'note'
		]);

		const raw = await db.relay.execute({
			sql: 'SELECT id, ciphertext FROM deleted_envelopes WHERE account_id = ? AND slot = ?',
			args: ['account', slot('b')]
		});
		expect(raw.rows[0] as unknown as { id: string; ciphertext: string }).toEqual({
			id: 'photo',
			ciphertext: 'cipher-photo'
		});
	});

	it('charges record overhead and purges retained ciphertext only when space is needed', async () => {
		const maxAccountBytes = ENVELOPE_STORAGE_OVERHEAD_BYTES + 5;
		const { store, db } = createStore({ maxAccountBytes });
		await store.createAccount('account', 'credential');
		await expect(
			store.sync('account', 0, [{ id: 'too-large', slot: slot('z'), ciphertext: '123456' }], [], 10)
		).rejects.toThrow(SyncQuotaExceededError);

		const first = await store.sync(
			'account',
			0,
			[{ id: 'old', slot: slot('a'), ciphertext: '12345' }],
			[],
			10
		);
		const deleted = await store.sync(
			'account',
			first.cursor,
			[],
			[{ id: 'old', slot: slot('a') }],
			10
		);
		expect(deleted.usage.storageBytes).toBe(maxAccountBytes);

		const replacement = await store.sync(
			'account',
			deleted.cursor,
			[{ id: 'new', slot: slot('b'), ciphertext: 'abcde' }],
			[],
			10
		);
		expect(replacement.usage.storageBytes).toBe(maxAccountBytes);
		const raw = await db.relay.execute('SELECT COUNT(*) AS count FROM deleted_envelopes');
		expect((raw.rows[0] as unknown as { count: number }).count).toBe(0);
	});

	it('purges staged slot deletions only after the grace window', async () => {
		const { store, db } = createStore();
		await store.createAccount('account', 'credential');
		const uploaded = await store.sync(
			'account',
			0,
			[{ id: 'photo', slot: slot('a'), ciphertext: 'opaque' }],
			[],
			10
		);
		await store.sync('account', uploaded.cursor, [], [{ id: 'photo', slot: slot('a') }], 10);

		const raw = await db.relay.execute('SELECT deleted_at AS deletedAt FROM deleted_envelopes');
		const { deletedAt } = raw.rows[0] as unknown as { deletedAt: number };

		expect(await store.purgeExpiredDeletedEnvelopes(deletedAt + DELETED_SLOT_GRACE_MS - 1)).toBe(0);
		expect(await store.purgeExpiredDeletedEnvelopes(deletedAt + DELETED_SLOT_GRACE_MS)).toBe(1);
	});

	it('returns the current slot and rejects a stale conditional replacement', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync(
			'account',
			0,
			[{ id: 'current', slot: slot('a'), ciphertext: 'remote' }],
			[],
			10
		);

		const stale = await store.sync(
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
		expect((await store.sync('account', 0, [], [], 10)).envelopes.map(({ id }) => id)).toEqual([
			'current'
		]);
	});

	it('rejects an entire mixed batch when any conditional replacement conflicts', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync(
			'account',
			0,
			[
				{ id: 'current-a', slot: slot('a'), ciphertext: 'a' },
				{ id: 'current-b', slot: slot('b'), ciphertext: 'b' }
			],
			[],
			10
		);

		const rejected = await store.sync(
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
		expect((await store.sync('account', 0, [], [], 10)).envelopes.map(({ id }) => id)).toEqual([
			'current-a',
			'current-b'
		]);
	});

	it('treats an identical envelope id retry as an idempotent acknowledgement', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		const upload = { id: 'same-id', slot: slot('a'), ciphertext: 'opaque', expectedId: null };
		const first = await store.sync('account', 0, [upload], [], 10);
		const retry = await store.sync('account', first.cursor, [upload], [], 10);

		expect(retry).toMatchObject({ cursor: 1, writesAccepted: true });
		expect(retry.usage).toMatchObject({ envelopeCount: 1, ciphertextBytes: 6 });
	});

	it('advances across sequence gaps left by current-state deletion', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync('account', 0, [{ id: 'old', slot: slot('a'), ciphertext: 'old' }], [], 10);
		await store.sync(
			'account',
			1,
			[{ id: 'new', slot: slot('a'), ciphertext: 'new', expectedId: 'old' }],
			[],
			10
		);
		await store.sync('account', 2, [], [{ id: 'new', slot: slot('a') }], 10);

		expect(await store.sync('account', 1, [], [], 10)).toMatchObject({
			cursor: 2,
			envelopes: [],
			hasMore: false
		});
	});

	it('does not overwrite the thirteenth remote slot before the client reads it', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		const remote = Array.from({ length: 13 }, (_, index) => ({
			id: `remote-${index + 1}`,
			slot: index.toString(16).padStart(64, '0'),
			ciphertext: `cipher-${index + 1}`
		}));
		await store.sync('account', 0, remote, [], 20);

		const first = await store.sync(
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
		const second = await store.sync('account', first.cursor, [], [], 12);
		expect(second.envelopes.map(({ id }) => id)).toEqual(['remote-13']);
	});

	it('stores and claims opaque reminder wakes independently by id', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		await store.replaceReminderWakes('account', [
			wake('b', 5_000),
			wake('a', 1_000),
			wake('c', 9_000)
		]);
		const claimed = await store.claimDueWakes(1_000);
		expect(claimed).toEqual([
			expect.objectContaining({
				accountId: 'account',
				deviceId: 'device-aaaaaaaaaaaa',
				wakeId: 'a'.repeat(43),
				fireAt: 1_000
			})
		]);
		expect(await store.claimDueWakes(1_000)).toEqual([]);
		await store.markWakeDelivered(claimed[0], 1_000);
		expect(await store.claimDueWakes(1_000)).toEqual([]);
	});

	it('re-claims an undelivered wake after the claim lease expires', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		await store.replaceReminderWakes('account', [wake('a', 1_000)]);
		const [claimed] = await store.claimDueWakes(1_000);
		expect(await store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS - 1)).toEqual([]);
		const reclaimed = await store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS);
		expect(reclaimed).toHaveLength(1);
		expect(reclaimed[0]).toMatchObject({ accountId: 'account', wakeId: wake('a', 1_000).id });
		await store.markWakeDelivered(reclaimed[0], 1_000 + WAKE_CLAIM_LEASE_MS);
		expect(await store.claimDueWakes(1_000 + WAKE_CLAIM_LEASE_MS)).toEqual([]);
	});

	it('moves an endpoint or device registration when another account claims it', async () => {
		const { store } = createStore();
		await store.createAccount('old-owner', 'credential-old');
		await store.createAccount('new-owner', 'credential-new');
		const keys = { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) };
		await store.savePushDevice({
			accountId: 'old-owner',
			deviceId: 'device-old00000000',
			endpoint: 'https://push.example/endpoint-a',
			...keys
		});
		await store.savePushDevice({
			accountId: 'new-owner',
			deviceId: 'device-new00000000',
			endpoint: 'https://push.example/endpoint-b',
			...keys
		});
		// A re-registered endpoint under a different account steals it from the old row.
		await store.savePushDevice({
			accountId: 'new-owner',
			deviceId: 'device-replaced000',
			endpoint: 'https://push.example/endpoint-a',
			...keys
		});
		// A re-registered device id under a different account moves the whole row.
		await store.savePushDevice({
			accountId: 'old-owner',
			deviceId: 'device-new00000000',
			endpoint: 'https://push.example/endpoint-c',
			...keys
		});
		expect(await store.countPushDevices('old-owner')).toBe(1);
		expect(await store.countPushDevices('new-owner')).toBe(1);
	});

	it('fans each account wake out once to every registered device', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.savePushDevice({
			deviceId: 'device-phone000000',
			endpoint: 'https://push.example/phone',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		await store.savePushDevice({
			deviceId: 'device-tablet00000',
			endpoint: 'https://push.example/tablet',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		await store.replaceReminderWakes('account', [wake('a', 1_000)]);
		const claimed = await store.claimDueWakes(1_000);
		expect(claimed.map((device) => device.deviceId).sort()).toEqual([
			'device-phone000000',
			'device-tablet00000'
		]);
		for (const delivery of claimed) await store.markWakeDelivered(delivery, 1_000);
		expect(await store.claimDueWakes(1_000)).toEqual([]);
	});

	it('keeps account wakes separate from registration and replaces them authoritatively', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.replaceReminderWakes('account', [wake('a', 1_000)]);
		await store.savePushDevice({
			deviceId: 'device-empty000000',
			endpoint: 'https://push.example/empty',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		await store.replaceReminderWakes('account', [wake('b', 2_000)]);
		const wakes = await store.claimDueWakes(2_001);
		expect(wakes.length).toBeGreaterThan(0);
		expect(wakes[0].wakeId).toBe('b'.repeat(43));
	});

	it('treats an identical mixed-case wake snapshot as a no-op at the same revision', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		const wakes = [
			{ id: `B${'x'.repeat(42)}`, fireAt: 1_000 },
			{ id: `a${'x'.repeat(42)}`, fireAt: 2_000 }
		];
		expect(await store.replaceReminderWakes('account', wakes, 5)).toBe(true);
		expect(await store.replaceReminderWakes('account', [...wakes].reverse(), 5)).toBe(true);
	});

	it('rejects stale reminder snapshots and retains delivery receipts across omission', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.savePushDevice({
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/sub-a',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16),
			accountId: 'account'
		});
		const reminder = wake('a', 1_000);
		expect(await store.replaceReminderWakes('account', [reminder], 5)).toBe(true);
		expect(await store.replaceReminderWakes('account', [], 5)).toBe(false);
		const [claimed] = await store.claimDueWakes(1_000);
		await store.markWakeDelivered(claimed, 1_000);

		expect(await store.replaceReminderWakes('account', [], 4)).toBe(false);
		expect(await store.replaceReminderWakes('account', [], 6)).toBe(true);
		expect(await store.replaceReminderWakes('account', [reminder], 7)).toBe(true);
		expect(await store.claimDueWakes(1_000)).toEqual([]);
	});

	it('rejects uploads whose ciphertext is not base64url', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await expect(
			store.sync(
				'account',
				0,
				[{ id: 'bad', slot: slot('a'), ciphertext: 'not+base64url/chars' }],
				[],
				10
			)
		).rejects.toThrow(/base64url/);
		expect((await store.sync('account', 0, [], [], 10)).usage.envelopeCount).toBe(0);
	});

	it('keeps at most 32 push devices per account', async () => {
		const { store } = createStore();
		await store.createAccount('account-a', 'credential-a');
		await store.createAccount('account-b', 'credential-b');
		for (let index = 0; index < 33; index++) {
			await store.savePushDevice({
				accountId: 'account-a',
				deviceId: `device-${String(index).padStart(12, '0')}`,
				endpoint: `https://push.example/sub-${index}`,
				p256dh: 'p'.repeat(20),
				auth: 'a'.repeat(16)
			});
		}
		await store.savePushDevice({
			accountId: 'account-b',
			deviceId: 'device-other000000',
			endpoint: 'https://push.example/other',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16)
		});
		expect(await store.countPushDevices('account-a')).toBe(32);
		expect(await store.countPushDevices('account-b')).toBe(1);
		expect(await store.countPushDevices()).toBe(33);
	});

	it('counts anonymous activity windows and deletes only stale accounts', async () => {
		const { store } = createStore();
		const now = 60 * 24 * 60 * 60 * 1000;
		await store.createAccount('fresh', 'credential', now);
		await store.createAccount('week-old', 'credential', now - 8 * 24 * 60 * 60 * 1000);
		await store.createAccount('stale', 'credential', 1);
		await store.sync('fresh', 0, [{ id: 'note', slot: slot('a'), ciphertext: 'opaque' }], [], 10);
		await store.touchAccount('fresh', now);
		await store.touchAccount('week-old', now - 8 * 24 * 60 * 60 * 1000);
		await store.touchAccount('stale', 1);

		expect(
			await store.operatorUsage({
				now,
				staleBefore: now - 20 * 24 * 60 * 60 * 1000
			})
		).toEqual({
			accounts: 3,
			envelopeCount: 1,
			ciphertextBytes: 'opaque'.length,
			storageBytes: ENVELOPE_STORAGE_OVERHEAD_BYTES + 'opaque'.length,
			activeByWindowDays: { '1': 1, '7': 1, '30': 2 },
			staleAccounts: 1
		});

		expect(await store.deleteInactiveAccounts(now - 20 * 24 * 60 * 60 * 1000)).toBe(1);
		expect(await store.getAuthCredential('stale')).toBeNull();
		expect(await store.getAuthCredential('fresh')).toBe('credential');
		expect(await store.getAuthCredential('week-old')).toBe('credential');
	});

	it('treats pull-only sync as activity without changing stored ciphertext', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential', 1);
		await store.touchAccount('account', 1);
		await store.sync('account', 0, [], [], 10);
		expect(await store.deleteInactiveAccounts(Date.now() - 1_000)).toBe(0);
		expect(await store.getAuthCredential('account')).toBe('credential');
	});

	it('resets a cursor that is ahead of a restored relay sequence', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync(
			'account',
			0,
			[{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }],
			[],
			10
		);

		expect(await store.sync('account', 50, [], [], 10)).toMatchObject({
			cursor: 0,
			reset: true,
			writesAccepted: false
		});
	});

	it('deletes an account and all of its opaque envelopes', async () => {
		const { store } = createStore();
		await store.createAccount('account', 'credential');
		await store.sync(
			'account',
			0,
			[{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }],
			[],
			10
		);
		await store.savePushDevice({
			accountId: 'account',
			deviceId: 'device-aaaaaaaaaaaa',
			endpoint: 'https://push.example/account',
			p256dh: 'p'.repeat(20),
			auth: 'a'.repeat(16)
		});
		await store.replaceReminderWakes('account', [wake('a', 1_000)]);
		expect(await store.deleteAccount('account')).toBe(true);
		expect(await store.getAuthCredential('account')).toBeNull();
		expect(await store.countPushDevices()).toBe(0);
	});
});
