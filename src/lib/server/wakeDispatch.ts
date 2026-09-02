import { getSyncStore, type DueWake, type SyncStore } from '$lib/server/syncStore';
import { sendReminderTick, type WakeSendResult } from '$lib/server/webPush';
import { recordReminderWake } from '$lib/server/metrics';

const SEND_CONCURRENCY = 8;

export type WakeSender = (device: DueWake) => Promise<WakeSendResult>;
export type WakeDispatchResult = { sent: number; failed: number; gone: number };

/** Claim due wakes, deliver them, and release what could not be sent so the next
 * tick retries once the claim lease expires. Driven by the cron tick. */
export async function dispatchDueWakes(
	options: { store?: SyncStore; send?: WakeSender; now?: () => number } = {}
): Promise<WakeDispatchResult> {
	const store = options.store ?? getSyncStore();
	const send = options.send ?? sendReminderTick;
	const now = options.now ?? Date.now;
	const result: WakeDispatchResult = { sent: 0, failed: 0, gone: 0 };
	const due = await store.claimDueWakes(now());
	for (let offset = 0; offset < due.length; offset += SEND_CONCURRENCY) {
		const batch = due.slice(offset, offset + SEND_CONCURRENCY);
		const results = await Promise.all(
			batch.map((device) =>
				Promise.resolve()
					.then(() => send(device))
					.catch((): WakeSendResult => 'failed')
			)
		);
		for (const [index, device] of batch.entries()) {
			const sendResult = results[index];
			if (sendResult === 'failed') {
				await store.releaseWakeClaim(device);
				recordReminderWake('failed');
				result.failed += 1;
				continue;
			}
			if (sendResult === 'gone') {
				await store.deletePushDevice(device.accountId, device.deviceId);
				recordReminderWake('gone');
				result.gone += 1;
				continue;
			}
			await store.markWakeDelivered(device, now());
			recordReminderWake('sent');
			result.sent += 1;
		}
	}
	await store.pruneStaleWakes(now());
	return result;
}
