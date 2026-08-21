import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({}) as Record<string, string | undefined>);

const storeMock = vi.hoisted(() => ({
	getMeta: vi.fn<(key: string) => string | null>(() => null),
	setMeta: vi.fn<(key: string, value: string) => void>(),
	countPushDevices: vi.fn<() => number>(() => 0)
}));

vi.mock('$env/dynamic/private', () => ({ env: envMock }));

vi.mock('$lib/server/syncStore', () => ({
	getSyncStore: () => storeMock
}));

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete envMock[name];
	else envMock[name] = value;
}

async function importFreshWebPush() {
	vi.resetModules();
	return await import('./webPush');
}

describe('getVapidKeys', () => {
	beforeEach(() => {
		storeMock.getMeta.mockReset();
		storeMock.getMeta.mockReturnValue(null);
		storeMock.setMeta.mockReset();
		storeMock.countPushDevices.mockReset();
		storeMock.countPushDevices.mockReturnValue(0);
		setEnv('SCRAPS_CACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPS_CACHE_VAPID_PRIVATE_KEY', undefined);
	});

	afterEach(() => {
		setEnv('SCRAPS_CACHE_VAPID_PUBLIC_KEY', undefined);
		setEnv('SCRAPS_CACHE_VAPID_PRIVATE_KEY', undefined);
		vi.restoreAllMocks();
	});

	it('returns env keys when both are configured', async () => {
		setEnv('SCRAPS_CACHE_VAPID_PUBLIC_KEY', 'env-public');
		setEnv('SCRAPS_CACHE_VAPID_PRIVATE_KEY', 'env-private');
		const { getVapidKeys } = await importFreshWebPush();
		expect(getVapidKeys()).toEqual({ publicKey: 'env-public', privateKey: 'env-private' });
		expect(storeMock.setMeta).not.toHaveBeenCalled();
	});

	it('throws when only one VAPID env key is configured', async () => {
		setEnv('SCRAPS_CACHE_VAPID_PUBLIC_KEY', 'env-public');
		const { getVapidKeys } = await importFreshWebPush();
		expect(() => getVapidKeys()).toThrow('Both SCRAPS_CACHE_VAPID_PUBLIC_KEY');
	});

	it('returns stored keys without regenerating', async () => {
		storeMock.getMeta.mockImplementation((key: string) =>
			key === 'vapid-private-v1' ? 'stored-private' : 'stored-public'
		);
		const { getVapidKeys } = await importFreshWebPush();
		expect(getVapidKeys()).toEqual({ publicKey: 'stored-public', privateKey: 'stored-private' });
		expect(storeMock.setMeta).not.toHaveBeenCalled();
	});

	it('generates and persists keys, warning once when devices are registered', async () => {
		storeMock.countPushDevices.mockReturnValue(3);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { getVapidKeys } = await importFreshWebPush();

		const first = getVapidKeys();
		expect(first.publicKey).toBeTruthy();
		expect(first.privateKey).toBeTruthy();
		expect(storeMock.setMeta).toHaveBeenCalledWith('vapid-public-v1', first.publicKey);
		expect(storeMock.setMeta).toHaveBeenCalledWith('vapid-private-v1', first.privateKey);

		getVapidKeys();

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

		getVapidKeys();

		expect(storeMock.setMeta).toHaveBeenCalledTimes(2);
		expect(warn).not.toHaveBeenCalled();
	});
});
