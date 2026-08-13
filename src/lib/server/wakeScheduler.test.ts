import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from './syncStore';
import { WakeScheduler } from './wakeScheduler';

const stores: SyncStore[] = [];
const directories: string[] = [];

function device(id: string, endpoint: string, accountId = 'account') {
	return {
		deviceId: id,
		endpoint,
		p256dh: 'p'.repeat(20),
		auth: 'a'.repeat(16),
		accountId
	};
}

function createStore(): SyncStore {
	const directory = mkdtempSync(join(tmpdir(), 'shard-wake-'));
	const store = new SyncStore(directory);
	directories.push(directory);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe('WakeScheduler', () => {
	it('sends one tick per due device and clears those wakes', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-aaaaaaaaaaaa', 'https://push.example/sub-a'), [500, 1_500]);
		const send = vi.fn().mockResolvedValue('sent');
		const scheduler = new WakeScheduler({
			store: () => store,
			send,
			now: () => 1_000
		});
		expect(await scheduler.tick()).toBe(1);
		expect(send).toHaveBeenCalledOnce();
		expect(store.listWakeTimes('account', 'device-aaaaaaaaaaaa')).toEqual([1_500]);
	});

	it('wakes every device on the account even if only one uploaded the time', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-phone000000', 'https://push.example/phone'), [100]);
		store.savePushDevice(device('device-tablet00000', 'https://push.example/tablet'), []);
		const send = vi.fn().mockResolvedValue('sent');
		const scheduler = new WakeScheduler({
			store: () => store,
			send,
			now: () => 200
		});
		expect(await scheduler.tick()).toBe(2);
		expect(send).toHaveBeenCalledTimes(2);
		expect(store.listWakeTimes('account')).toEqual([]);
	});

	it('drops a gone subscription and retries a failed send later', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-gone0000000', 'https://push.example/gone'), [100]);
		store.savePushDevice(device('device-fail0000000', 'https://push.example/fail'), [100]);
		const send = vi.fn(async (device: { deviceId: string }) =>
			device.deviceId.includes('gone') ? 'gone' : 'failed'
		);
		const scheduler = new WakeScheduler({
			store: () => store,
			send,
			now: () => 200
		});
		await scheduler.tick();
		expect(store.countPushDevices()).toBe(1);
		expect(store.listWakeTimes('account', 'device-fail0000000')).toEqual([100]);
	});

	it('does not immediately reschedule after a failed send', async () => {
		vi.useFakeTimers();
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-fail0000000', 'https://push.example/fail'), [100]);
		const send = vi.fn().mockResolvedValue('failed');
		const scheduler = new WakeScheduler({
			store: () => store,
			send,
			now: () => 200
		});
		scheduler.start();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).toHaveBeenCalledOnce();
		scheduler.stop();
		vi.useRealTimers();
	});
});
