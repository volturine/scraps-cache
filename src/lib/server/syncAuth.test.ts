import { describe, expect, it } from 'vitest';
import { sameSyncSecret, syncSecretHash } from './syncAuth';

describe('sync secret hashing', () => {
	it('verifies the matching secret against a stored scrypt hash', async () => {
		const hash = await syncSecretHash('correct-horse-battery-staple');
		expect(hash).toMatch(/^scrypt:v1:\d+:\d+:\d+:[0-9a-f]+:[0-9a-f]+$/);
		expect(hash).not.toContain('correct-horse-battery-staple');
		await expect(sameSyncSecret(hash, 'correct-horse-battery-staple')).resolves.toBe(true);
	});

	it('produces a unique salted hash per call', async () => {
		const first = await syncSecretHash('same-secret');
		const second = await syncSecretHash('same-secret');
		expect(first).not.toBe(second);
		await expect(sameSyncSecret(second, 'same-secret')).resolves.toBe(true);
	});

	it('rejects a wrong secret', async () => {
		const hash = await syncSecretHash('correct-secret');
		await expect(sameSyncSecret(hash, 'wrong-secret')).resolves.toBe(false);
	});

	it('fails closed on malformed stored hashes', async () => {
		const malformed = [
			'',
			'plaintext',
			'deadbeef',
			'sha256:v1:deadbeef',
			`scrypt:v1:16384:8:${'ab'.repeat(32)}`,
			`scrypt:v1:notanumber:8:1:${'aa'.repeat(16)}:${'bb'.repeat(32)}`,
			`scrypt:v1:16384:8:1:${'zz'.repeat(16)}:${'bb'.repeat(32)}`,
			`scrypt:v1:16384:8:1:${'aa'.repeat(4)}:${'bb'.repeat(32)}`,
			`scrypt:v1:16384:8:1:${'aa'.repeat(16)}:${'bb'.repeat(8)}`,
			`scrypt:v1:1024:8:1:${'aa'.repeat(16)}:${'bb'.repeat(32)}`
		];
		for (const hash of malformed) {
			await expect(sameSyncSecret(hash, 'any-secret')).resolves.toBe(false);
		}
	});
});
