import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

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
