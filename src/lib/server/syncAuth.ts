import {
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual,
	type ScryptOptions
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
	secret: string | Buffer,
	salt: string | Buffer,
	keyLength: number,
	options: ScryptOptions
) => Promise<Buffer>;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DEFAULT_PARAMS: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MAX_PARAMS_MEMORY = 128 * 1024 * 1024;

/** Stored format: `scrypt:v1:N:r:p:saltHex:hashHex`. No legacy formats are accepted. */
export async function syncSecretHash(secret: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const derived = await scrypt(secret, salt, KEY_BYTES, DEFAULT_PARAMS);
	const { N, r, p } = DEFAULT_PARAMS as Required<Pick<ScryptOptions, 'N' | 'r' | 'p'>>;
	return `scrypt:v1:${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

function parseStoredHash(expectedHash: string): {
	salt: Buffer;
	expected: Buffer;
	params: ScryptOptions;
} | null {
	const parts = expectedHash.split(':');
	if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return null;
	const [costN, blockR, parallelP, saltHex, hashHex] = parts.slice(2);
	if (
		!/^\d+$/.test(costN) ||
		!/^\d+$/.test(blockR) ||
		!/^\d+$/.test(parallelP) ||
		!/^[0-9a-f]+$/.test(saltHex) ||
		!/^[0-9a-f]+$/.test(hashHex)
	) {
		return null;
	}
	const params: ScryptOptions = {
		N: Number(costN),
		r: Number(blockR),
		p: Number(parallelP),
		maxmem: MAX_PARAMS_MEMORY
	};
	if (params.N! < 16384 || params.r! < 1 || params.r! > 64 || params.p! < 1 || params.p! > 16) {
		return null;
	}
	const salt = Buffer.from(saltHex, 'hex');
	const expected = Buffer.from(hashHex, 'hex');
	if (salt.length < SALT_BYTES || expected.length < KEY_BYTES) return null;
	return { salt, expected, params };
}

export async function sameSyncSecret(expectedHash: string, secret: string): Promise<boolean> {
	const stored = parseStoredHash(expectedHash);
	if (!stored) return false;
	try {
		const actual = await scrypt(secret, stored.salt, stored.expected.length, stored.params);
		return timingSafeEqual(actual, stored.expected);
	} catch {
		return false;
	}
}
