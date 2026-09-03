import { env } from '$env/dynamic/private';
import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { getMeta, getDb, setMetaIfAbsent, type Db } from '$lib/server/db';
import { getSyncStore, type DueWake } from '$lib/server/syncStore';

export const VAPID_KEY_PAIR_META_KEY = 'vapid-key-pair-v1';

export type WakeSendResult = 'sent' | 'gone' | 'failed';

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const VAPID_TTL_SECONDS = 12 * 60 * 60;

let warnedDefaultSubject = false;
let warnedKeyRegeneration = false;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded =
		value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function vapidSubject(): string {
	const subject = env.SCRAPSCACHE_VAPID_SUBJECT?.trim();
	if (subject && (/^mailto:/i.test(subject) || /^https:/i.test(subject))) return subject;
	const origin = env.SCRAPSCACHE_ORIGIN?.trim() || env.ORIGIN?.trim();
	if (origin && /^https:/i.test(origin)) return origin.replace(/\/$/, '');
	if (!warnedDefaultSubject) {
		warnedDefaultSubject = true;
		console.warn(
			JSON.stringify({
				level: 'warn',
				event: 'vapid_subject_default',
				message: 'SCRAPSCACHE_VAPID_SUBJECT is not configured; using placeholder mailto subject'
			})
		);
	}
	return 'mailto:scrapscache@localhost';
}

function warnKeyRegeneration(registeredDevices: number): void {
	if (warnedKeyRegeneration || registeredDevices === 0) return;
	warnedKeyRegeneration = true;
	console.warn(
		JSON.stringify({
			level: 'warn',
			event: 'vapid_key_regenerated',
			message:
				'VAPID signing key was regenerated while push devices are registered; existing push subscriptions are invalidated and devices must re-register',
			registeredDevices
		})
	);
}

function parseVapidKeyPair(value: string): { publicKey: string; privateKey: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error('Stored VAPID key pair is invalid');
	}
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		typeof (parsed as { publicKey?: unknown }).publicKey !== 'string' ||
		typeof (parsed as { privateKey?: unknown }).privateKey !== 'string' ||
		(parsed as { publicKey: string }).publicKey.length === 0 ||
		(parsed as { privateKey: string }).privateKey.length === 0
	) {
		throw new Error('Stored VAPID key pair is invalid');
	}
	return parsed as { publicKey: string; privateKey: string };
}

function generateVapidKeyPair(): { publicKey: string; privateKey: string } {
	const privateKey = p256.utils.randomSecretKey();
	return {
		publicKey: bytesToBase64Url(p256.getPublicKey(privateKey, false)),
		privateKey: bytesToBase64Url(privateKey)
	};
}

export async function getVapidKeys(
	db: Db = getDb()
): Promise<{ publicKey: string; privateKey: string }> {
	await db.ready;
	const fromEnvPublic = env.SCRAPSCACHE_VAPID_PUBLIC_KEY?.trim();
	const fromEnvPrivate = env.SCRAPSCACHE_VAPID_PRIVATE_KEY?.trim();
	if (Boolean(fromEnvPublic) !== Boolean(fromEnvPrivate)) {
		throw new Error(
			'Both SCRAPSCACHE_VAPID_PUBLIC_KEY and SCRAPSCACHE_VAPID_PRIVATE_KEY are required'
		);
	}
	if (fromEnvPublic && fromEnvPrivate) {
		return { publicKey: fromEnvPublic, privateKey: fromEnvPrivate };
	}

	const stored = await getMeta(db, VAPID_KEY_PAIR_META_KEY);
	if (stored) return parseVapidKeyPair(stored);

	const generated = generateVapidKeyPair();
	const candidate = JSON.stringify(generated);
	const persisted = await setMetaIfAbsent(db, VAPID_KEY_PAIR_META_KEY, candidate);
	if (persisted === candidate) {
		warnKeyRegeneration(await getSyncStore().countPushDevices());
	}
	return parseVapidKeyPair(persisted);
}

/** RFC 8291 aes128gcm body. `web-push` cannot run on Workers: it needs Node
 * `createECDH` and `https.request`. */
export function encryptWebPushPayload(input: {
	plaintext: Uint8Array;
	userPublicKey: Uint8Array;
	authSecret: Uint8Array;
	serverPrivateKey: Uint8Array;
	salt: Uint8Array;
}): Uint8Array {
	const serverPublicKey = p256.getPublicKey(input.serverPrivateKey, false);
	const ecdhSecret = p256
		.getSharedSecret(input.serverPrivateKey, input.userPublicKey, true)
		.subarray(1);
	const ikm = hkdf(
		sha256,
		ecdhSecret,
		input.authSecret,
		concatBytes(
			encoder.encode('WebPush: info'),
			new Uint8Array([0]),
			input.userPublicKey,
			serverPublicKey
		),
		32
	);
	const cek = hkdf(
		sha256,
		ikm,
		input.salt,
		concatBytes(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
		16
	);
	const nonce = hkdf(
		sha256,
		ikm,
		input.salt,
		concatBytes(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])),
		12
	);
	const ciphertext = gcm(cek, nonce).encrypt(concatBytes(input.plaintext, new Uint8Array([2])));
	const rs = new Uint8Array(4);
	new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
	return concatBytes(
		input.salt,
		rs,
		new Uint8Array([serverPublicKey.length]),
		serverPublicKey,
		ciphertext
	);
}

function vapidAuthorization(
	audience: string,
	subject: string,
	keys: { publicKey: string; privateKey: string }
): string {
	const header = bytesToBase64Url(encoder.encode('{"typ":"JWT","alg":"ES256"}'));
	const payload = bytesToBase64Url(
		encoder.encode(
			JSON.stringify({
				aud: audience,
				exp: Math.floor(Date.now() / 1000) + VAPID_TTL_SECONDS,
				sub: subject
			})
		)
	);
	const signingInput = `${header}.${payload}`;
	const signature = p256.sign(encoder.encode(signingInput), base64UrlToBytes(keys.privateKey), {
		prehash: true,
		format: 'compact'
	});
	return `vapid t=${signingInput}.${bytesToBase64Url(signature)}, k=${bytesToBase64Url(base64UrlToBytes(keys.publicKey))}`;
}

export async function sendReminderTick(device: DueWake): Promise<WakeSendResult> {
	try {
		const keys = await getVapidKeys();
		const userPublicKey = base64UrlToBytes(device.p256dh);
		const authSecret = base64UrlToBytes(device.auth);
		if (userPublicKey.length !== 65 || authSecret.length < 16) {
			throw new Error('Push subscription keys are invalid');
		}
		const salt = new Uint8Array(16);
		crypto.getRandomValues(salt);
		const body = new Uint8Array(
			encryptWebPushPayload({
				plaintext: encoder.encode(
					JSON.stringify({ type: 'reminder-wake', id: device.wakeId, fireAt: device.fireAt })
				),
				userPublicKey,
				authSecret,
				serverPrivateKey: p256.utils.randomSecretKey(),
				salt
			})
		);
		const response = await fetch(device.endpoint, {
			method: 'POST',
			headers: {
				TTL: '86400',
				Urgency: 'high',
				Authorization: vapidAuthorization(new URL(device.endpoint).origin, vapidSubject(), keys),
				'Content-Encoding': 'aes128gcm',
				'Content-Type': 'application/octet-stream'
			},
			body,
			signal: AbortSignal.timeout(10_000)
		});
		if (response.ok) return 'sent';
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'reminder_wake_failed',
				status: response.status
			})
		);
		if (response.status === 404 || response.status === 410) return 'gone';
		return 'failed';
	} catch (error) {
		console.info(
			JSON.stringify({
				level: 'info',
				event: 'reminder_wake_failed',
				status: null,
				message: error instanceof Error ? error.message : 'Web Push delivery failed'
			})
		);
		return 'failed';
	}
}
