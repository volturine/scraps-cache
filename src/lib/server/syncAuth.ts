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

type PendingChallenge = { accountId: string; challenge: string; expiresAt: number };
type Session = { accountId: string; expiresAt: number };

const challenges = new Map<string, PendingChallenge>();
const sessions = new Map<string, Session>();

function pruneExpiredAuthState(now: number): void {
	for (const [id, challenge] of challenges) {
		if (challenge.expiresAt <= now) challenges.delete(id);
	}
	for (const [hash, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(hash);
	}
}

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

export function createSyncChallenge(accountId: string): {
	challengeId: string;
	challenge: string;
	expiresAt: number;
} {
	pruneExpiredAuthState(Date.now());
	const challengeId = base64Url(randomBytes(16));
	const challenge = base64Url(randomBytes(32));
	const expiresAt = Date.now() + CHALLENGE_TTL_MS;
	challenges.set(challengeId, { accountId, challenge, expiresAt });
	return { challengeId, challenge, expiresAt };
}

export function exchangeSyncChallenge(
	accountId: string,
	publicKey: string,
	challengeId: string,
	signature: string
): { accessToken: string; expiresAt: number } | null {
	pruneExpiredAuthState(Date.now());
	const pending = challenges.get(challengeId);
	challenges.delete(challengeId);
	if (!pending || pending.accountId !== accountId || pending.expiresAt <= Date.now()) return null;
	if (
		!verifySignature(
			publicKey,
			signature,
			`scraps-cache-auth-challenge:v1:${accountId}:${pending.challenge}`
		)
	)
		return null;
	return createSyncSession(accountId);
}

export function createSyncSession(accountId: string): { accessToken: string; expiresAt: number } {
	const accessToken = base64Url(randomBytes(32));
	const expiresAt = Date.now() + SESSION_TTL_MS;
	sessions.set(tokenHash(accessToken), { accountId, expiresAt });
	return { accessToken, expiresAt };
}

export function authenticateSyncRequest(request: Request): string | null {
	pruneExpiredAuthState(Date.now());
	const authorization = request.headers.get('authorization');
	if (!authorization?.startsWith('Bearer ')) return null;
	const token = authorization.slice('Bearer '.length);
	if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
	const hash = tokenHash(token);
	const session = sessions.get(hash);
	if (!session) return null;
	if (session.expiresAt <= Date.now()) {
		sessions.delete(hash);
		return null;
	}
	return session.accountId;
}

export function revokeSyncSessions(accountId: string): void {
	for (const [hash, session] of sessions) {
		if (session.accountId === accountId) sessions.delete(hash);
	}
}

export function resetSyncAuthForTests(): void {
	challenges.clear();
	sessions.clear();
}
