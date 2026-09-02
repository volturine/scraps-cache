import { describe, expect, it, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client/node';
import { PairingSessions } from './pairingSessions';
import { createDb, type Db } from './db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = 'k'.repeat(43);
const grant = { ciphertext: 'cipher' };

let cleanup: (() => void)[] = [];

afterEach(() => {
	for (const fn of cleanup) fn();
	cleanup = [];
});

function testDb(): Db {
	const dir = mkdtempSync(join(tmpdir(), 'scraps-test-'));
	cleanup.push(() => rmSync(dir, { recursive: true }));
	const relay = createClient({ url: 'file:' + join(dir, 'relay.db') });
	const ops = createClient({ url: 'file:' + join(dir, 'ops.db') });
	return createDb({ relay, ops });
}

describe('anonymous pairing rendezvous', () => {
	it('matches two independently-started devices and relays only an opaque grant', async () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(testDb(), () => ids.shift()!);
		const old = await s.start('tag', 'existing', key, 1);
		const fresh = await s.start('tag', 'new', key, 2);
		expect(await s.poll(old.id, 3)).toMatchObject({ state: 'matched' });
		expect(await s.submitGrant(old.id, grant, 4)).toEqual({ success: true });
		expect(await s.poll(fresh.id, 5)).toMatchObject({ state: 'connected', grant });
	});
	it('expires both sides after sixty seconds', async () => {
		const s = new PairingSessions(testDb(), () => 'old');
		const old = await s.start('tag', 'existing', key, 1);
		expect(await s.poll(old.id, 60_001)).toEqual({ state: 'expired' });
	});
	it('reports expired, not not-found, to the surviving peer', async () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(testDb(), () => ids.shift()!);
		const old = await s.start('tag', 'existing', key, 1);
		const fresh = await s.start('tag', 'new', key, 2);
		expect(await s.poll(old.id, 60_001)).toEqual({ state: 'expired' });
		expect(await s.poll(fresh.id, 60_002)).toEqual({ state: 'expired' });
	});
	it('accepts only the first grant per session', async () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(testDb(), () => ids.shift()!);
		const old = await s.start('tag', 'existing', key, 1);
		await s.start('tag', 'new', key, 2);
		expect(await s.submitGrant(old.id, grant, 4)).toEqual({ success: true });
		expect(await s.submitGrant(old.id, { ciphertext: 'second' }, 5)).toEqual({
			success: false,
			reason: 'already-granted'
		});
		expect(await s.poll('new', 6)).toMatchObject({ state: 'connected', grant });
	});
	it('rejects grants that have no matched peer yet', async () => {
		let id = 0;
		const s = new PairingSessions(testDb(), () => `id-${id++}`);
		const existing = await s.start('tag', 'existing', key, 1);
		const fresh = await s.start('other', 'new', key, 2);
		expect(await s.submitGrant(existing.id, grant, 3)).toEqual({
			success: false,
			reason: 'unmatched'
		});
		expect(await s.submitGrant(fresh.id, grant, 4)).toEqual({
			success: false,
			reason: 'unmatched'
		});
	});
	it('refuses to start sessions once the rendezvous table is full', async () => {
		const ids = ['first', 'second'];
		const s = new PairingSessions(testDb(), () => ids.shift()!, 2);
		await s.start('tag-a', 'existing', key, 1);
		await s.start('tag-b', 'new', key, 2);
		await expect(s.start('tag-c', 'existing', key, 3)).rejects.toThrow(
			'Pairing rendezvous is busy'
		);
	});
});
