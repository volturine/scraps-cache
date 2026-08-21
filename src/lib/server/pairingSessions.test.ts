import { describe, expect, it } from 'vitest';
import { PairingSessions } from './pairingSessions';
const key = 'k'.repeat(43);
const grant = { existingPublicKey: 'e'.repeat(43), ciphertext: 'cipher' };
describe('anonymous pairing rendezvous', () => {
	it('matches two independently-started devices and relays only an opaque grant', () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(() => ids.shift()!);
		const old = s.start('tag', 'existing', key, 1);
		const fresh = s.start('tag', 'new', key, 2);
		expect(s.poll(old.id, 3)).toMatchObject({ state: 'matched' });
		expect(s.submitGrant(old.id, grant, 4)).toEqual({ success: true });
		expect(s.poll(fresh.id, 5)).toMatchObject({ state: 'connected', grant });
	});
	it('expires both sides after sixty seconds', () => {
		const s = new PairingSessions(() => 'old');
		const old = s.start('tag', 'existing', key, 1);
		expect(s.poll(old.id, 60_001)).toEqual({ state: 'expired' });
	});
	it('reports expired, not not-found, to the surviving peer', () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(() => ids.shift()!);
		const old = s.start('tag', 'existing', key, 1);
		const fresh = s.start('tag', 'new', key, 2);
		expect(s.poll(old.id, 60_001)).toEqual({ state: 'expired' });
		expect(s.poll(fresh.id, 60_002)).toEqual({ state: 'expired' });
	});
	it('accepts only the first grant per session', () => {
		const ids = ['old', 'new'];
		const s = new PairingSessions(() => ids.shift()!);
		const old = s.start('tag', 'existing', key, 1);
		s.start('tag', 'new', key, 2);
		expect(s.submitGrant(old.id, grant, 4)).toEqual({ success: true });
		expect(s.submitGrant(old.id, { ciphertext: 'second' }, 5)).toEqual({
			success: false,
			reason: 'already-granted'
		});
		expect(s.poll('new', 6)).toMatchObject({ state: 'connected', grant });
	});
	it('rejects grants that have no matched peer yet', () => {
		const s = new PairingSessions(() => 'fresh');
		const existing = s.start('tag', 'existing', key, 1);
		const fresh = s.start('other', 'new', key, 2);
		expect(s.submitGrant(existing.id, grant, 3)).toEqual({ success: false, reason: 'unmatched' });
		expect(s.submitGrant(fresh.id, grant, 4)).toEqual({ success: false, reason: 'unmatched' });
	});
	it('refuses to start sessions once the rendezvous table is full', () => {
		const ids = ['first', 'second'];
		const s = new PairingSessions(() => ids.shift()!, 2);
		s.start('tag-a', 'existing', key, 1);
		s.start('tag-b', 'new', key, 2);
		expect(() => s.start('tag-c', 'existing', key, 3)).toThrow('Pairing rendezvous is busy');
	});
});
