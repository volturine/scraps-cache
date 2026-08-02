import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const FORMAT = 'shard-encrypted-backup';
const FORMAT_VERSION = 1;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export type BackupKdf = {
	name: 'argon2id';
	salt: string;
	memoryKiB: number;
	iterations: number;
	parallelism: number;
};

export type EncryptedBackupChunk = {
	nonce: string;
	ciphertext: string;
};

export type EncryptedShardBackup = {
	format: typeof FORMAT;
	version: typeof FORMAT_VERSION;
	kdf: BackupKdf;
	chunkBytes: number;
	chunkCount: number;
	chunks: EncryptedBackupChunk[];
};

export type BackupEncryptionOptions = {
	memoryKiB?: number;
	iterations?: number;
	parallelism?: number;
	chunkBytes?: number;
};

function randomBytes(length: number): Uint8Array {
	const value = new Uint8Array(length);
	crypto.getRandomValues(value);
	return value;
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Backup contains invalid encoded data');
	const padded = value.replaceAll('-', '+').replaceAll('_', '/')
		+ '='.repeat((4 - value.length % 4) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function validateKdf(kdf: BackupKdf): void {
	const saltBytes = base64UrlToBytes(kdf.salt);
	if (kdf.name !== 'argon2id' || saltBytes.length < 16 || saltBytes.length > 64) {
		throw new Error('Backup has invalid key settings');
	}
	if (!Number.isInteger(kdf.memoryKiB) || kdf.memoryKiB < 8 || kdf.memoryKiB > 262_144
		|| !Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > 10
		|| !Number.isInteger(kdf.parallelism) || kdf.parallelism < 1 || kdf.parallelism > 4) {
		throw new Error('Backup has unsafe key settings');
	}
}

async function deriveKey(passphrase: string, kdf: BackupKdf): Promise<Uint8Array> {
	if (!passphrase) throw new Error('Backup passphrase is required');
	validateKdf(kdf);
	return argon2idAsync(passphrase, base64UrlToBytes(kdf.salt), {
		t: kdf.iterations,
		m: kdf.memoryKiB,
		p: kdf.parallelism,
		dkLen: 32,
		maxmem: kdf.memoryKiB * 1024 + 8 * 1024 * 1024,
		asyncTick: 8
	});
}

function chunkAad(kdf: BackupKdf, index: number, count: number): Uint8Array {
	return encoder.encode(JSON.stringify({
		format: FORMAT,
		version: FORMAT_VERSION,
		kdf,
		index,
		count
	}));
}

export function isEncryptedShardBackup(value: unknown): value is EncryptedShardBackup {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<EncryptedShardBackup>;
	return candidate.format === FORMAT
		&& candidate.version === FORMAT_VERSION
		&& !!candidate.kdf
		&& candidate.kdf.name === 'argon2id'
		&& Number.isInteger(candidate.chunkBytes)
		&& Number.isInteger(candidate.chunkCount)
		&& Array.isArray(candidate.chunks);
}

export async function encryptBackup(
	payload: unknown,
	passphrase: string,
	options: BackupEncryptionOptions = {}
): Promise<EncryptedShardBackup> {
	const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 8 * 1024 * 1024) {
		throw new Error('Invalid backup chunk size');
	}
	const kdf: BackupKdf = {
		name: 'argon2id',
		salt: bytesToBase64Url(randomBytes(16)),
		memoryKiB: options.memoryKiB ?? 19_456,
		iterations: options.iterations ?? 2,
		parallelism: options.parallelism ?? 1
	};
	const key = await deriveKey(passphrase, kdf);
	const plaintext = encoder.encode(JSON.stringify(payload));
	const chunkCount = Math.max(1, Math.ceil(plaintext.length / chunkBytes));
	const chunks: EncryptedBackupChunk[] = [];

	for (let index = 0; index < chunkCount; index++) {
		const nonce = randomBytes(24);
		const start = index * chunkBytes;
		const part = plaintext.slice(start, Math.min(plaintext.length, start + chunkBytes));
		const ciphertext = xchacha20poly1305(key, nonce, chunkAad(kdf, index, chunkCount)).encrypt(part);
		chunks.push({
			nonce: bytesToBase64Url(nonce),
			ciphertext: bytesToBase64Url(ciphertext)
		});
	}
	key.fill(0);
	return { format: FORMAT, version: FORMAT_VERSION, kdf, chunkBytes, chunkCount, chunks };
}

export async function decryptBackup(
	backup: EncryptedShardBackup,
	passphrase: string
): Promise<unknown> {
	if (!isEncryptedShardBackup(backup)) throw new Error('Not an encrypted Shard backup');
	validateKdf(backup.kdf);
	if (backup.chunkCount < 1 || backup.chunkCount > 100_000
		|| backup.chunks.length !== backup.chunkCount
		|| backup.chunkBytes < 1024 || backup.chunkBytes > 8 * 1024 * 1024) {
		throw new Error('Backup is incomplete');
	}
	const key = await deriveKey(passphrase, backup.kdf);
	const parts: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		for (let index = 0; index < backup.chunkCount; index++) {
			const chunk = backup.chunks[index];
			if (!chunk || typeof chunk.nonce !== 'string' || typeof chunk.ciphertext !== 'string') {
				throw new Error('Backup is incomplete');
			}
			const nonce = base64UrlToBytes(chunk.nonce);
			if (nonce.length !== 24) throw new Error('Backup contains an invalid nonce');
			const plaintext = xchacha20poly1305(
				key,
				nonce,
				chunkAad(backup.kdf, index, backup.chunkCount)
			).decrypt(base64UrlToBytes(chunk.ciphertext));
			totalBytes += plaintext.length;
			if (totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('Backup is too large');
			parts.push(plaintext);
		}
	} catch (error) {
		throw new Error('Backup passphrase is incorrect or the file is damaged', { cause: error });
	} finally {
		key.fill(0);
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const part of parts) {
		combined.set(part, offset);
		offset += part.length;
	}
	try {
		return JSON.parse(decoder.decode(combined)) as unknown;
	} catch (error) {
		throw new Error('Backup contents are invalid', { cause: error });
	}
}
