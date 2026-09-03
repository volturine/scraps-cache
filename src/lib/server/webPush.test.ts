import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({}) as Record<string, string | undefined>);

const storeMock = vi.hoisted(() => ({
	getMeta: vi.fn<(key: string) => string | null>(() => null),
	setMetaIfAbsent: vi.fn<(key: string, value: string) => string>((_key, value) => value),
	countPushDevices: vi.fn<() => number>(() => 0)
}));

vi.mock('$env/dynamic/private', () => ({ env: envMock }));

vi.mock('$lib/server/syncStore', () => ({
	getSyncStore: () => ({ countPushDevices: storeMock.countPushDevices })
}));

vi.mock('$lib/server/db', () => ({
	getDb: () => ({ ready: Promise.resolve() }),
	getMeta: (_db: unknown, key: string) => storeMock.getMeta(key),
	setMetaIfAbsent: (_db: unknown, key: string, value: string) =>
		storeMock.setMetaIfAbsent(key, value)
}));

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete envMock[name];
	else envMock[name] = value;
}

async function importFreshWebPush() {
	vi.resetModules();
	vi.doMock('$lib/server/db', () => ({
		getDb: () => ({ ready: Promise.resolve() }),
		getMeta: (_db: unknown, key: string) => storeMock.getMeta(key),
		setMetaIfAbsent: (_db: unknown, key: string, value: string) =>
			storeMock.setMetaIfAbsent(key, value)
	}));
	vi.doMock('$lib/server/syncStore', () => ({
		getSyncStore: () => ({ countPushDevices: storeMock.countPushDevices })
	}));
	vi.doMock('$env/dynamic/private', () => ({ env: envMock }));
	return await import('./webPush');
}

describe('getVapidKeys', () => {
	beforeEach(() => {
		storeMock.getMeta.mockReset();
		storeMock.getMeta.mockReturnValue(null);
		storeMock.setMetaIfAbsent.mockReset();
		storeMock.setMetaIfAbsent.mockImplementation((_key, value) => value);
		storeMock.countPushDevices.mockReset();
		storeMock.countPushDevices.mockReturnValue(0);
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPSCACHE_VAPID_PRIVATE_KEY', undefined);
	});

	afterEach(() => {
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPSCACHE_VAPID_PRIVATE_KEY', undefined);
		vi.restoreAllMocks();
	});

	it('returns env keys when both are configured', async () => {
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', 'env-public');
		setEnv('SCRAPSCACHE_VAPID_PRIVATE_KEY', 'env-private');
		const { getVapidKeys } = await importFreshWebPush();
		expect(await getVapidKeys()).toEqual({ publicKey: 'env-public', privateKey: 'env-private' });
		expect(storeMock.setMetaIfAbsent).not.toHaveBeenCalled();
	});

	it('throws when only one VAPID env key is configured', async () => {
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', 'env-public');
		const { getVapidKeys } = await importFreshWebPush();
		await expect(getVapidKeys()).rejects.toThrow('Both SCRAPSCACHE_VAPID_PUBLIC_KEY');
	});

	it('returns stored keys without regenerating', async () => {
		storeMock.getMeta.mockReturnValue(
			JSON.stringify({ publicKey: 'stored-public', privateKey: 'stored-private' })
		);
		const { getVapidKeys } = await importFreshWebPush();
		expect(await getVapidKeys()).toEqual({
			publicKey: 'stored-public',
			privateKey: 'stored-private'
		});
		expect(storeMock.setMetaIfAbsent).not.toHaveBeenCalled();
	});

	it('generates and persists keys, warning once when devices are registered', async () => {
		storeMock.countPushDevices.mockReturnValue(3);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { getVapidKeys } = await importFreshWebPush();

		const first = await getVapidKeys();
		expect(first.publicKey).toBeTruthy();
		expect(first.privateKey).toBeTruthy();
		expect(storeMock.setMetaIfAbsent).toHaveBeenCalledWith(
			'vapid-key-pair-v1',
			JSON.stringify(first)
		);

		await getVapidKeys();

		expect(warn).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(vi.mocked(warn).mock.calls[0][0]) as Record<string, unknown>;
		expect(payload.event).toBe('vapid_key_regenerated');
		expect(payload.registeredDevices).toBe(3);
		expect(warn.mock.calls[0][0]).not.toContain(first.privateKey);
		expect(warn.mock.calls[0][0]).not.toContain(first.publicKey);
	});

	it('generates and persists keys without warning when no devices are registered', async () => {
		storeMock.countPushDevices.mockReturnValue(0);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { getVapidKeys } = await importFreshWebPush();

		await getVapidKeys();

		expect(storeMock.setMetaIfAbsent).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it('returns the winning atomic key pair during concurrent initialization', async () => {
		const winner = { publicKey: 'winner-public', privateKey: 'winner-private' };
		storeMock.setMetaIfAbsent.mockReturnValue(JSON.stringify(winner));
		const { getVapidKeys } = await importFreshWebPush();

		expect(await getVapidKeys()).toEqual(winner);
	});

	it('generates uncompressed P-256 keys in web-push url-safe form', async () => {
		const { getVapidKeys } = await importFreshWebPush();
		const keys = await getVapidKeys();
		const publicKey = base64UrlToBytes(keys.publicKey);
		const privateKey = base64UrlToBytes(keys.privateKey);
		expect(publicKey).toHaveLength(65);
		expect(publicKey[0]).toBe(0x04);
		expect(privateKey).toHaveLength(32);
	});
});

function base64UrlToBytes(value: string): Uint8Array {
	const compact = value.replace(/\s+/g, '');
	const padded =
		compact.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (compact.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

describe('encryptWebPushPayload', () => {
	it('matches the RFC 8291 example ciphertext', async () => {
		const { encryptWebPushPayload } = await importFreshWebPush();
		const body = encryptWebPushPayload({
			plaintext: new TextEncoder().encode('When I grow up, I want to be a watermelon'),
			userPublicKey: base64UrlToBytes(
				'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
			),
			authSecret: base64UrlToBytes('BTBZMqHH6r4Tts7J_aSIgg'),
			serverPrivateKey: base64UrlToBytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
			salt: base64UrlToBytes('DGv6ra1nlYgDCS1FRnbzlw')
		});
		expect(bytesToBase64Url(body)).toBe(
			'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
		);
	});
});

describe('sendReminderTick', () => {
	beforeEach(() => {
		storeMock.getMeta.mockReset();
		storeMock.getMeta.mockReturnValue(null);
		storeMock.setMetaIfAbsent.mockReset();
		storeMock.setMetaIfAbsent.mockImplementation((_key, value) => value);
		storeMock.countPushDevices.mockReset();
		storeMock.countPushDevices.mockReturnValue(0);
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPSCACHE_VAPID_PRIVATE_KEY', undefined);
		setEnv('SCRAPSCACHE_ORIGIN', 'https://scrapscache.com');
	});

	afterEach(() => {
		setEnv('SCRAPSCACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPSCACHE_VAPID_PRIVATE_KEY', undefined);
		setEnv('SCRAPSCACHE_ORIGIN', undefined);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	async function validDevice() {
		const { p256 } = await import('@noble/curves/nist.js');
		const userPrivate = p256.utils.randomSecretKey();
		const auth = new Uint8Array(16);
		crypto.getRandomValues(auth);
		return {
			accountId: 'account',
			deviceId: 'device',
			wakeId: 'A'.repeat(43),
			fireAt: 1_700_000_000_000,
			endpoint: 'https://fcm.googleapis.com/fcm/send/fake-token',
			p256dh: bytesToBase64Url(p256.getPublicKey(userPrivate, false)),
			auth: bytesToBase64Url(auth)
		};
	}

	it('posts an aes128gcm body with string headers via fetch', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal('fetch', fetchMock);
		const { sendReminderTick } = await importFreshWebPush();

		await expect(sendReminderTick(await validDevice())).resolves.toBe('sent');

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://fcm.googleapis.com/fcm/send/fake-token');
		expect(init.method).toBe('POST');
		const headers = init.headers as Record<string, string>;
		for (const value of Object.values(headers)) expect(typeof value).toBe('string');
		expect(headers.TTL).toBe('86400');
		expect(headers.Urgency).toBe('high');
		expect(headers['Content-Encoding']).toBe('aes128gcm');
		expect(headers.Authorization).toMatch(
			/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/
		);
		const jwtPayload = JSON.parse(
			new TextDecoder().decode(base64UrlToBytes(headers.Authorization.split('.')[1]))
		) as { aud: string; sub: string };
		expect(jwtPayload.aud).toBe('https://fcm.googleapis.com');
		expect(jwtPayload.sub).toBe('https://scrapscache.com');
		expect(init.body).toBeInstanceOf(Uint8Array);
		const body = init.body as Uint8Array;
		expect(body.byteLength).toBeGreaterThan(86);
		expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
		expect(body[20]).toBe(65);
		expect(body[21]).toBe(0x04);
	});

	it('treats 404 and 410 as gone subscriptions', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 410 }))
		);
		const { sendReminderTick } = await importFreshWebPush();
		await expect(sendReminderTick(await validDevice())).resolves.toBe('gone');
	});

	it('returns failed when fetch throws', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network');
			})
		);
		const info = vi.spyOn(console, 'info').mockImplementation(() => {});
		const { sendReminderTick } = await importFreshWebPush();
		await expect(sendReminderTick(await validDevice())).resolves.toBe('failed');
		expect(info).toHaveBeenCalled();
		expect(String(info.mock.calls[0]?.[0])).toContain('reminder_wake_failed');
	});
});
