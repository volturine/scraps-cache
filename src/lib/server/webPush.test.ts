import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({}) as Record<string, string | undefined>);

const storeMock = vi.hoisted(() => ({
	getMeta: vi.fn<(key: string) => string | null>(() => null),
	setMetaIfAbsent: vi.fn<(key: string, value: string) => string>((_key, value) => value),
	countPushDevices: vi.fn<() => number>(() => 0)
}));

vi.mock('$lib/server/env', () => ({
	getSecret: (key: string) => envMock[key]
}));

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
	vi.doMock('$lib/server/env', () => ({
		getSecret: (key: string) => envMock[key]
	}));
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
});
