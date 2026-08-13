import { describe, expect, it } from 'vitest';
import {
	createPairingRequestKey,
	createSyncIdentity,
	formatPairingCode,
	normalizePairingCode,
	openSyncKeyFromPeer,
	pairingCodeTag,
	sealSyncKeyForPeer
} from './syncPairing';
describe('sync pairing', () => {
	it('formats and normalizes a sync key', () => {
		expect(formatPairingCode('12345678901234')).toBe('1234-5678-901234');
		expect(normalizePairingCode('1234-5678-901234')).toBe('12345678901234');
	});
	it('uses a stable opaque tag', () => {
		expect(pairingCodeTag('12345678901234')).toBe(pairingCodeTag('1234-5678-901234'));
	});
	it('PAKE encrypts the sync key only for a peer with the same sync key', () => {
		const identity = createSyncIdentity(),
			code = identity.pairingCode,
			old = createPairingRequestKey(code),
			fresh = createPairingRequestKey(code),
			grant = sealSyncKeyForPeer(identity.syncKey, code, old, fresh.share);
		expect(openSyncKeyFromPeer(code, fresh, old.share, grant)).toBe(identity.syncKey);
		const attacker = createPairingRequestKey('00000000000000');
		expect(() => openSyncKeyFromPeer('00000000000000', attacker, old.share, grant)).toThrow();
	});
});
