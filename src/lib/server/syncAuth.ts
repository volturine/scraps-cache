import { timingSafeEqual } from 'crypto';
import { sha256 as sha256Bytes } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function syncSecretHash(secret: string): string {
	return bytesToHex(sha256Bytes(new TextEncoder().encode(`shard-sync-secret:v1:${secret}`)));
}

export function sameSyncSecret(expectedHash: string, secret: string): boolean {
	const actual = syncSecretHash(secret);
	const expected = Buffer.from(expectedHash, 'utf8');
	const received = Buffer.from(actual, 'utf8');
	return expected.length === received.length && timingSafeEqual(expected, received);
}
