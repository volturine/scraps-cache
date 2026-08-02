import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncQuotaExceededError, SyncStore } from './syncStore';

const stores: SyncStore[] = [];
const directories: string[] = [];
const slot = (character: string) => character.repeat(64);

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

	it('paginates existing data without skipping simultaneous uploads', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync('account', 0, [
			{ id: 'a', slot: slot('a'), ciphertext: 'a' },
			{ id: 'b', slot: slot('b'), ciphertext: 'b' },
			{ id: 'c', slot: slot('c'), ciphertext: 'c' }
		], 10);

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
		store.sync(
			'account',
			0,
			[{ id: 'old', slot: slot('a'), ciphertext: 'first' }],
			10
		);
		store.sync(
			'account',
			1,
			[{ id: 'new', slot: slot('a'), ciphertext: 'replacement' }],
			10
		);

		const result = store.sync('account', 1, [], 10);
		expect(result.envelopes).toEqual([
			{ seq: 2, id: 'new', slot: slot('a'), ciphertext: 'replacement' }
		]);
	});

	it('rolls back the entire upload batch when an account quota is exceeded', () => {
		const { store } = createStore({ maxAccountBytes: 5 });
		store.createAccount('account', 'credential');
		expect(() => store.sync('account', 0, [
			{ id: 'a', slot: slot('a'), ciphertext: '123' },
			{ id: 'b', slot: slot('b'), ciphertext: '456' }
		], 10)).toThrow(SyncQuotaExceededError);

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

	it('deletes an account and all of its opaque envelopes', () => {
		const { store } = createStore();
		store.createAccount('account', 'credential');
		store.sync(
			'account',
			0,
			[{ id: 'record', slot: slot('a'), ciphertext: 'opaque' }],
			10
		);
		expect(store.deleteAccount('account')).toBe(true);
		expect(store.getCredentialHash('account')).toBeNull();
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
});
