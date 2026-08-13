import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from './syncStore';
import { WakeScheduler } from './wakeScheduler';

const stores: SyncStore[] = [];
const directories: string[] = [];

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
		store.savePushDevice(
			'account',
			{
				deviceId: 'device-aaaaaaaaaaaa',
				endpoint: 'https://push.example/sub-a',
				p256dh: 'p'.repeat(20),
				auth: 'a'.repeat(16)
			},
			[500, 1_500]
		);
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

	it('drops a gone subscription and retries a failed send later', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(
			'account',
			{
				deviceId: 'device-gone0000000',
				endpoint: 'https://push.example/gone',
				p256dh: 'p'.repeat(20),
				auth: 'a'.repeat(16)
			},
			[100]
		);
		store.savePushDevice(
			'account',
			{
				deviceId: 'device-fail0000000',
				endpoint: 'https://push.example/fail',
				p256dh: 'p'.repeat(20),
				auth: 'a'.repeat(16)
			},
			[100]
		);
		const send = vi.fn(async (device: { deviceId: string }) =>
			device.deviceId.includes('gone') ? 'gone' : 'failed'
		);
		const scheduler = new WakeScheduler({
			store: () => store,
			send,
			now: () => 200
		});
		await scheduler.tick();
		expect(store.countPushDevices('account')).toBe(1);
		expect(store.listWakeTimes('account', 'device-fail0000000')).toEqual([100]);
	});
});
