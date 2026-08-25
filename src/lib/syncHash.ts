import { hmac } from '@noble/hashes/hmac.js';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// Deterministic SHA-256 for sync equality checks. Object keys are sorted so browser and server
// hash the same record regardless of object construction order.
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
		.join(',')}}`;
}

export async function sha256(value: unknown): Promise<string> {
	return bytesToHex(sha256Bytes(new TextEncoder().encode(stableStringify(value))));
}

const TAG_KEY_PREFIX = 'scraps-cache-sync-tag:v1:';

/**
 * Deterministic, key-derived content tag for one sync record. Any device
 * holding the sync key recomputes the same tag for the same content; to the
 * relay it is an opaque 32-byte value that cannot be dictionary-attacked.
 */
export async function recordTag(syncKey: string, value: unknown): Promise<string> {
	const key = sha256Bytes(new TextEncoder().encode(TAG_KEY_PREFIX + syncKey));
	const mac = hmac(sha256Bytes, key, new TextEncoder().encode(stableStringify(value)));
	return bytesToHex(mac);
}

/** Order-independent contribution of one tag to a bundle digest. */
export function tagContribution(tag: string): string {
	return bytesToHex(sha256Bytes(hexToBytes(tag)));
}

export function xorHex(left: string, right: string): string {
	const a = hexToBytes(left);
	const b = hexToBytes(right);
	const out = new Uint8Array(a.length);
	for (let index = 0; index < out.length; index++) out[index] = a[index] ^ b[index];
	return bytesToHex(out);
}

export const EMPTY_TAG_DIGEST = '00'.repeat(32);
