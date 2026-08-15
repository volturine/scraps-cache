import { getSyncStore, type DueWake } from '$lib/server/syncStore';
import { sendReminderTick, type WakeSendResult } from '$lib/server/webPush';
import { recordReminderWake } from '$lib/server/metrics';

const IDLE_MS = 30_000;
const MIN_DELAY_MS = 250;
const FAILED_RETRY_MS = 30_000;

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

	nudge(): void {
		if (!this.started) {
			this.start();
			return;
		}
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
		let failed = false;
		try {
			const now = this.now();
			const due = this.store().claimDueWakes(now);
			for (const device of due) {
				const result = await this.send(device);
				if (result === 'failed') {
					this.store().releaseWakeClaim(device);
					recordReminderWake('failed');
					failed = true;
					continue;
				}
				if (result === 'gone') {
					this.store().deletePushDevice(device.accountId, device.deviceId);
					recordReminderWake('gone');
					continue;
				}
				this.store().markWakeDelivered(device, now);
				recordReminderWake('sent');
				sent += 1;
			}
			this.store().pruneStaleWakes(now);
		} finally {
			this.running = false;
			if (this.started) this.arm(failed);
		}
		return sent;
	}

	private arm(failed = false): void {
		if (failed) {
			this.schedule(FAILED_RETRY_MS);
			return;
		}
		const next = this.store().nextWakeAt(this.now());
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
