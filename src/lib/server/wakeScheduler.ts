import { getSyncStore, type DueWake } from '$lib/server/syncStore';
import { sendReminderTick, type WakeSendResult } from '$lib/server/webPush';
import { recordReminderWake } from '$lib/server/metrics';

const IDLE_MS = 30_000;
const MIN_DELAY_MS = 250;

export type WakeSender = (device: DueWake) => Promise<WakeSendResult>;

export class WakeScheduler {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private running = false;
	private readonly send: WakeSender;
	private readonly store: typeof getSyncStore;
	private readonly now: () => number;

	constructor(
		options: {
			send?: WakeSender;
			store?: typeof getSyncStore;
			now?: () => number;
		} = {}
	) {
		this.send = options.send ?? sendReminderTick;
		this.store = options.store ?? getSyncStore;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.schedule(MIN_DELAY_MS);
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.started = false;
	}

	async tick(): Promise<number> {
		if (this.running) return 0;
		this.running = true;
		let sent = 0;
		try {
			const now = this.now();
			const due = this.store().duePushDevices(now);
			for (const device of due) {
				const result = await this.send(device);
				if (result === 'failed') continue;
				if (result === 'gone') {
					this.store().deletePushDevice(device.accountId, device.deviceId);
					recordReminderWake('gone');
					continue;
				}
				this.store().clearDueWakes(device.accountId, device.deviceId, now);
				recordReminderWake('sent');
				sent += 1;
			}
		} finally {
			this.running = false;
			if (this.started) this.arm();
		}
		return sent;
	}

	private arm(): void {
		const next = this.store().nextWakeAt();
		const now = this.now();
		const delay = next == null ? IDLE_MS : Math.min(IDLE_MS, Math.max(MIN_DELAY_MS, next - now));
		this.schedule(delay);
	}

	private schedule(delay: number): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			void this.tick();
		}, delay);
		this.timer.unref?.();
	}
}

export const wakeScheduler = new WakeScheduler();
