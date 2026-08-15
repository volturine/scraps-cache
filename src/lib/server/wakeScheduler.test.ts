import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncStore } from './syncStore';
import { WakeScheduler } from './wakeScheduler';

const stores: SyncStore[] = [];
const directories: string[] = [];
const wake = (character: string, fireAt: number) => ({ id: character.repeat(43), fireAt });

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
	vi.useRealTimers();
});

describe('WakeScheduler', () => {
	it('sends and records one delivery for each due device and wake', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-aaaaaaaaaaaa', 'https://push.example/sub-a'));
		store.replaceReminderWakes('account', [wake('a', 500), wake('b', 1_500)]);
		const send = vi.fn().mockResolvedValue('sent');
		const scheduler = new WakeScheduler({ store: () => store, send, now: () => 1_000 });
		expect(await scheduler.tick()).toBe(1);
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({ wakeId: 'a'.repeat(43), fireAt: 500 })
		);
		expect(store.claimDueWakes(1_000)).toEqual([]);
		expect(store.nextWakeAt(1_000)).toBe(1_500);
	});

	it('wakes every account device even when a device has no local note', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-phone000000', 'https://push.example/phone'));
		store.savePushDevice(device('device-tablet00000', 'https://push.example/tablet'));
		store.replaceReminderWakes('account', [wake('a', 100)]);
		const send = vi.fn().mockResolvedValue('sent');
		const scheduler = new WakeScheduler({ store: () => store, send, now: () => 200 });
		expect(await scheduler.tick()).toBe(2);
		expect(send).toHaveBeenCalledTimes(2);
		expect(store.claimDueWakes(200)).toEqual([]);
	});

	it('delivers a retained due wake to a device registered later', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-phone000000', 'https://push.example/phone'));
		store.replaceReminderWakes('account', [wake('a', 100)]);
		const send = vi.fn().mockResolvedValue('sent');
		const scheduler = new WakeScheduler({ store: () => store, send, now: () => 200 });
		expect(await scheduler.tick()).toBe(1);
		store.savePushDevice(device('device-tablet00000', 'https://push.example/tablet'));
		expect(await scheduler.tick()).toBe(1);
		expect(send.mock.calls[1]?.[0]).toMatchObject({ deviceId: 'device-tablet00000' });
	});

	it('drops a gone subscription and releases a failed delivery for retry', async () => {
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-gone0000000', 'https://push.example/gone'));
		store.savePushDevice(device('device-fail0000000', 'https://push.example/fail'));
		store.replaceReminderWakes('account', [wake('a', 100)]);
		const send = vi.fn(async (delivery: { deviceId: string }) =>
			delivery.deviceId.includes('gone') ? 'gone' : 'failed'
		);
		const scheduler = new WakeScheduler({ store: () => store, send, now: () => 200 });
		await scheduler.tick();
		expect(store.countPushDevices()).toBe(1);
		expect(store.claimDueWakes(200).map((delivery) => delivery.deviceId)).toEqual([
			'device-fail0000000'
		]);
	});

	it('does not immediately reschedule after a failed send', async () => {
		vi.useFakeTimers();
		const store = createStore();
		store.createAccount('account', 'credential');
		store.savePushDevice(device('device-fail0000000', 'https://push.example/fail'));
		store.replaceReminderWakes('account', [wake('a', 100)]);
		const send = vi.fn().mockResolvedValue('failed');
		const scheduler = new WakeScheduler({ store: () => store, send, now: () => 200 });
		scheduler.start();
		await vi.advanceTimersByTimeAsync(250);
		expect(send).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(send).toHaveBeenCalledOnce();
		scheduler.stop();
	});
});
