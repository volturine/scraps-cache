import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
	randomBytes,
	scrypt as scryptCallback,
	timingSafeEqual,
	type ScryptOptions
} from 'node:crypto';
import { promisify } from 'node:util';
import { getDb, type Db } from '$lib/server/db';

const encoder = new TextEncoder();
const CHALLENGE_TTL_MS = 60_000;
export const SESSION_TTL_MS = 30 * 60 * 1000;
const scrypt = promisify(scryptCallback) as (
	secret: string | Buffer,
	salt: string | Buffer,
	keyLength: number,
	options: ScryptOptions
) => Promise<Buffer>;
const LEGACY_SCRYPT_PARAMS: ScryptOptions = {
	N: 16384,
	r: 8,
	p: 1,
	maxmem: 128 * 1024 * 1024
};

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string, length: number): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const decoded = Uint8Array.from(Buffer.from(value, 'base64url'));
	return decoded.length === length ? decoded : null;
}

function tokenHash(token: string): string {
	return bytesToHex(sha256(encoder.encode(token)));
}

export function validAuthPublicKey(publicKey: string): boolean {
	const bytes = decodeBase64Url(publicKey, 32);
	if (!bytes) return false;
	try {
		const point = ed25519.Point.fromBytes(bytes, false);
		return !point.is0() && !point.isSmallOrder() && point.isTorsionFree();
	} catch {
		return false;
	}
}

function verifySignature(publicKey: string, signature: string, message: string): boolean {
	const publicKeyBytes = decodeBase64Url(publicKey, 32);
	const signatureBytes = decodeBase64Url(signature, 64);
	if (!publicKeyBytes || !signatureBytes || !validAuthPublicKey(publicKey)) return false;
	try {
		return ed25519.verify(signatureBytes, encoder.encode(message), publicKeyBytes, {
			zip215: false
		});
	} catch {
		return false;
	}
}

export function verifySyncRegistration(
	accountId: string,
	publicKey: string,
	signature: string
): boolean {
	return verifySignature(
		publicKey,
		signature,
		`scraps-cache-auth-registration:v1:${accountId}:${publicKey}`
	);
}

export function verifySyncMigration(
	accountId: string,
	publicKey: string,
	signature: string
): boolean {
	return verifySignature(
		publicKey,
		signature,
		`scraps-cache-auth-migration:v1:${accountId}:${publicKey}`
	);
}

export function isLegacySyncCredential(credential: string): boolean {
	return credential.startsWith('scrypt:v1:');
}

export async function legacySyncSecretHash(secret: string): Promise<string> {
	const salt = randomBytes(16);
	const derived = await scrypt(secret, salt, 32, LEGACY_SCRYPT_PARAMS);
	return `scrypt:v1:16384:8:1:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function sameLegacySyncSecret(hash: string, secret: string): Promise<boolean> {
	const parts = hash.split(':');
	if (
		parts.length !== 7 ||
		parts[0] !== 'scrypt' ||
		parts[1] !== 'v1' ||
		parts[2] !== '16384' ||
		parts[3] !== '8' ||
		parts[4] !== '1' ||
		!/^[0-9a-f]{32}$/.test(parts[5]) ||
		!/^[0-9a-f]{64}$/.test(parts[6])
	)
		return false;
	try {
		const actual = await scrypt(secret, Buffer.from(parts[5], 'hex'), 32, LEGACY_SCRYPT_PARAMS);
		return timingSafeEqual(actual, Buffer.from(parts[6], 'hex'));
	} catch {
		return false;
	}
}

/** Shared auth state: challenge/response login and bearer sessions, durable across
 * server isolates so any instance can issue or accept a challenge. */
export class SyncAuth {
	constructor(private readonly db: Db) {}

	async createSyncChallenge(accountId: string): Promise<{
		challengeId: string;
		challenge: string;
		expiresAt: number;
	}> {
		await this.db.ready;
		const now = Date.now();
		await this.db.ops.execute({
			sql: 'DELETE FROM auth_challenges WHERE expires_at <= ?',
			args: [now]
		});
		const challengeId = base64Url(randomBytes(16));
		const challenge = base64Url(randomBytes(32));
		const expiresAt = now + CHALLENGE_TTL_MS;
		await this.db.ops.execute({
			sql: 'INSERT INTO auth_challenges(challenge_id, account_id, challenge, expires_at) VALUES (?, ?, ?, ?)',
			args: [challengeId, accountId, challenge, expiresAt]
		});
		return { challengeId, challenge, expiresAt };
	}

	async exchangeSyncChallenge(
		accountId: string,
		publicKey: string,
		challengeId: string,
		signature: string
	): Promise<{ accessToken: string; expiresAt: number } | null> {
		await this.db.ready;
		const now = Date.now();
		const consumed = await this.db.ops.execute({
			sql: `DELETE FROM auth_challenges
			 WHERE challenge_id = ? AND account_id = ? AND expires_at > ?
			 RETURNING challenge AS challenge`,
			args: [challengeId, accountId, now]
		});
		const pending = consumed.rows[0] as unknown as { challenge: string } | undefined;
		if (!pending) return null;
		if (
			!verifySignature(
				publicKey,
				signature,
				`scraps-cache-auth-challenge:v1:${accountId}:${pending.challenge}`
			)
		)
			return null;
		return this.createSyncSession(accountId);
	}

	async createSyncSession(accountId: string): Promise<{ accessToken: string; expiresAt: number }> {
		await this.db.ready;
		const accessToken = base64Url(randomBytes(32));
		const expiresAt = Date.now() + SESSION_TTL_MS;
		await this.db.ops.execute({
			sql: 'INSERT INTO auth_sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)',
			args: [tokenHash(accessToken), accountId, expiresAt]
		});
		return { accessToken, expiresAt };
	}

	async authenticateSyncRequest(request: Request): Promise<string | null> {
		await this.db.ready;
		const authorization = request.headers.get('authorization');
		if (!authorization?.startsWith('Bearer ')) return null;
		const token = authorization.slice('Bearer '.length);
		if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
		const hash = tokenHash(token);
		const result = await this.db.ops.execute({
			sql: 'SELECT account_id AS accountId, expires_at AS expiresAt FROM auth_sessions WHERE token_hash = ?',
			args: [hash]
		});
		const session = result.rows[0] as unknown as
			{ accountId: string; expiresAt: number } | undefined;
		if (!session) return null;
		if (session.expiresAt <= Date.now()) {
			await this.db.ops.execute({
				sql: 'DELETE FROM auth_sessions WHERE token_hash = ?',
				args: [hash]
			});
			return null;
		}
		return session.accountId;
	}

	async revokeSyncSessions(accountId: string): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM auth_sessions WHERE account_id = ?',
			args: [accountId]
		});
	}

	async pruneExpired(now = Date.now()): Promise<void> {
		await this.db.ready;
		await this.db.ops.execute({
			sql: 'DELETE FROM auth_challenges WHERE expires_at <= ?',
			args: [now]
		});
		await this.db.ops.execute({
			sql: 'DELETE FROM auth_sessions WHERE expires_at <= ?',
			args: [now]
		});
	}
}

let singleton: SyncAuth | undefined;

export function getSyncAuth(): SyncAuth {
	singleton ??= new SyncAuth(getDb());
	return singleton;
}

export function closeSyncAuth(): void {
	singleton = undefined;
}
