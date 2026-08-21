import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from './syncStore';

const wake = (character: string, fireAt: number) => ({ id: character.repeat(43), fireAt });

/**
 * Issue #80: the wake revision is the device's committed sync cursor. After a
 * relay sequence reset (restore from an older backup), device cursors restart
 * low while accounts.wake_revision keeps the old high-water mark, so wake
 * publishing is rejected until the cursor climbs past it.
 */
describe('wake revision across a relay sequence reset', () => {
	it('accepts a wake snapshot republished at the post-reset cursor', () => {
		const directory = mkdtempSync(join(tmpdir(), 'scraps-cache-wake-reset-'));
		const store = new SyncStore(directory);
		try {
			store.createAccount('account', 'credential');

			// The device catches up to relay sequence 5 and publishes wakes there.
			store.sync(
				'account',
				0,
				Array.from({ length: 5 }, (_, index) => ({
					id: `env-${index}`,
					slot: index.toString(16).padStart(64, '0'),
					ciphertext: 'opaque'
				})),
				[],
				10
			);
			expect(store.replaceReminderWakes('account', [wake('a', 1_000)], 5)).toBe(true);

			// The relay is restored from an older backup: next_seq regresses to 1.
			const database = (
				store as unknown as {
					database: { prepare(sql: string): { run(...values: unknown[]): unknown } };
				}
			).database;
			database.prepare('DELETE FROM envelopes WHERE account_id = ?').run('account');
			database.prepare('UPDATE accounts SET next_seq = 1 WHERE account_id = ?').run('account');

			// The device detects the reset, rewinds to 0 and rebuilds to cursor 2.
			const reset = store.sync('account', 5, [], [], 10);
			expect(reset.reset).toBe(true);
			const rebuilt = store.sync(
				'account',
				0,
				[{ id: 'env-new', slot: 'f'.repeat(64), ciphertext: 'opaque' }],
				[],
				10
			);
			expect(rebuilt.writesAccepted).toBe(true);
			expect(rebuilt.cursor).toBe(2);

			// The device republishes its wakes at its new committed revision.
			expect(store.replaceReminderWakes('account', [wake('a', 1_000)], 2)).toBe(true);
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
