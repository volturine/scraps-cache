import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { cpace } from '@cipherman/pake-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CODE_DIGITS = 14;
export type SyncIdentity = {
	syncKey: string;
	accountId: string;
	authSecret: string;
	pairingCode: string;
};
export type PairingRequestKey = { ephemeralSecret: string; share: string };
export type PairingGrant = { ciphertext: string };

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function base64UrlToBytes(value: string): Uint8Array {
	const padded =
		value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
function secureBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}
export function normalizePairingCode(value: string): string | null {
	const digits = value.replace(/\D/g, '');
	return digits.length === CODE_DIGITS ? digits : null;
}
export function formatPairingCode(value: string): string {
	const digits = value.replace(/\D/g, '').slice(0, CODE_DIGITS);
	return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8)].filter(Boolean).join('-');
}
export function identityFromSyncKey(syncKey: string): SyncIdentity {
	const raw = base64UrlToBytes(syncKey);
	if (raw.length !== 32) throw new Error('Invalid sync key');
	const accountId = bytesToBase64Url(
		sha256(encoder.encode(`shard-account-id:v1:${syncKey}`)).slice(0, 18)
	);
	const authSecret = bytesToBase64Url(sha256(encoder.encode(`shard-account-auth:v1:${syncKey}`)));
	const codeValue = BigInt(
		`0x${bytesToHex(sha256(encoder.encode(`shard-pairing-code:v1:${syncKey}`)).slice(0, 8))}`
	);
	return {
		syncKey,
		accountId,
		authSecret,
		pairingCode: (codeValue % 100_000_000_000_000n).toString().padStart(CODE_DIGITS, '0')
	};
}
export function createSyncIdentity(): SyncIdentity {
	return identityFromSyncKey(bytesToBase64Url(secureBytes(32)));
}
export function randomOpaqueId(): string {
	return bytesToBase64Url(secureBytes(16));
}
export function pairingCodeTag(code: string): string {
	const normalized = normalizePairingCode(code);
	if (!normalized) throw new Error('Sync key must contain 14 digits');
	return bytesToHex(sha256(encoder.encode(`shard-pairing-tag:v1:${normalized}`)));
}
function pakeInputs(code: string) {
	const normalized = normalizePairingCode(code);
	if (!normalized) throw new Error('Sync key must contain 14 digits');
	const tag = pairingCodeTag(normalized);
	return {
		PRS: sha256(encoder.encode(`shard-pake-prs:v1:${normalized}`)),
		sid: encoder.encode(tag),
		CI: encoder.encode('shard-sync-rendezvous:v1')
	};
}
export function createPairingRequestKey(code: string): PairingRequestKey {
	const init = cpace.ristretto255.init(pakeInputs(code));
	return {
		ephemeralSecret: bytesToBase64Url(init.ephemeralSecret),
		share: bytesToBase64Url(init.share)
	};
}
function pakeKey(code: string, own: PairingRequestKey, peerShare: string): Uint8Array {
	const inputs = pakeInputs(code);
	const isk = cpace.ristretto255.deriveIskSymmetric({
		ephemeralSecret: base64UrlToBytes(own.ephemeralSecret),
		ownShare: base64UrlToBytes(own.share),
		peerShare: base64UrlToBytes(peerShare),
		sid: inputs.sid,
		ownAD: inputs.CI,
		peerAD: inputs.CI
	});
	return sha256(encoder.encode(`shard-pake-transfer:v1:${bytesToBase64Url(isk)}`));
}
export function sealSyncKeyForPeer(
	syncKey: string,
	code: string,
	own: PairingRequestKey,
	peerShare: string
): PairingGrant {
	identityFromSyncKey(syncKey);
	const nonce = secureBytes(24);
	const ciphertext = xchacha20poly1305(pakeKey(code, own, peerShare), nonce).encrypt(
		encoder.encode(JSON.stringify({ syncKey }))
	);
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce);
	packed.set(ciphertext, nonce.length);
	return { ciphertext: bytesToBase64Url(packed) };
}
export function openSyncKeyFromPeer(
	code: string,
	own: PairingRequestKey,
	peerShare: string,
	grant: PairingGrant
): string {
	const packed = base64UrlToBytes(grant.ciphertext);
	if (packed.length <= 24) throw new Error('Invalid encrypted sync key');
	const decoded = JSON.parse(
		decoder.decode(
			xchacha20poly1305(pakeKey(code, own, peerShare), packed.slice(0, 24)).decrypt(
				packed.slice(24)
			)
		)
	) as { syncKey?: unknown };
	if (typeof decoded.syncKey !== 'string') throw new Error('Invalid encrypted sync key');
	identityFromSyncKey(decoded.syncKey);
	return decoded.syncKey;
}
function syncPayloadKey(syncKey: string): Uint8Array {
	identityFromSyncKey(syncKey);
	return sha256(encoder.encode(`shard-sync-payload:v1:${syncKey}`));
}
export function encryptSyncPayload(syncKey: string, payload: unknown): string {
	const nonce = secureBytes(24);
	const ciphertext = xchacha20poly1305(syncPayloadKey(syncKey), nonce).encrypt(
		encoder.encode(JSON.stringify(payload))
	);
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce);
	packed.set(ciphertext, nonce.length);
	return bytesToBase64Url(packed);
}
export function decryptSyncPayload(syncKey: string, envelope: string): unknown {
	const packed = base64UrlToBytes(envelope);
	if (packed.length <= 24) throw new Error('Invalid encrypted sync envelope');
	return JSON.parse(
		decoder.decode(
			xchacha20poly1305(syncPayloadKey(syncKey), packed.slice(0, 24)).decrypt(packed.slice(24))
		)
	);
}
