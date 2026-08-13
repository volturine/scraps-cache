import { describe, expect, it } from 'vitest';
import {
	decryptBackup,
	encryptBackup,
	isEncryptedShardBackup,
	type BackupEncryptionOptions
} from './backupCrypto';

const fast: BackupEncryptionOptions = {
	memoryKiB: 32,
	iterations: 1,
	parallelism: 1,
	chunkBytes: 1024
};

describe('encrypted Shard backups', () => {
	it('round-trips multiple authenticated chunks', async () => {
		const source = { notes: [{ id: 'one', body: 'private '.repeat(500) }], labels: [] };
		const encrypted = await encryptBackup(source, 'a strong backup passphrase', fast);
		expect(isEncryptedShardBackup(encrypted)).toBe(true);
		expect(encrypted.chunks.length).toBeGreaterThan(1);
		await expect(decryptBackup(encrypted, 'a strong backup passphrase')).resolves.toEqual(source);
	});

	it('rejects an incorrect passphrase and modified ciphertext', async () => {
		const encrypted = await encryptBackup({ notes: [], labels: [] }, 'correct passphrase', fast);
		await expect(decryptBackup(encrypted, 'wrong passphrase')).rejects.toThrow(
			'incorrect or the file is damaged'
		);

		const ciphertext = encrypted.chunks[0].ciphertext;
		encrypted.chunks[0].ciphertext = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`;
		await expect(decryptBackup(encrypted, 'correct passphrase')).rejects.toThrow(
			'incorrect or the file is damaged'
		);
	});

	it('rejects missing or reordered chunks', async () => {
		const encrypted = await encryptBackup({ body: 'x'.repeat(3000) }, 'correct passphrase', fast);
		const missing = { ...encrypted, chunks: encrypted.chunks.slice(1) };
		await expect(decryptBackup(missing, 'correct passphrase')).rejects.toThrow('incomplete');

		const reordered = { ...encrypted, chunks: [...encrypted.chunks].reverse() };
		await expect(decryptBackup(reordered, 'correct passphrase')).rejects.toThrow(
			'incorrect or the file is damaged'
		);
	});

	it('authenticates key settings in the backup header', async () => {
		const encrypted = await encryptBackup({ notes: ['secret'] }, 'correct passphrase', fast);
		const changedHeader = {
			...encrypted,
			kdf: { ...encrypted.kdf, iterations: encrypted.kdf.iterations + 1 }
		};
		await expect(decryptBackup(changedHeader, 'correct passphrase')).rejects.toThrow(
			'incorrect or the file is damaged'
		);
	});
});
