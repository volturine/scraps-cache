import { tickAppClock } from '$lib/appClock.svelte';
import { getFiredReminderKeys, markFiredReminderKey } from '$lib/db/idb';
import {
	nextReminderAt,
	notificationPermission,
	pruneFiredReminders,
	relayReminderWakes,
	reminderPreview,
	reminderWakeId,
	showReminderNotification,
	unfiredDueReminders,
	type ReminderAlert,
	type ReminderNote
} from '$lib/reminderNotify';
import { publishReminderWakes, registerReminderDevice } from '$lib/reminderWake';

const MAX_TIMER_MS = 60_000;

export class ReminderStore {
	alerts = $state<ReminderAlert[]>([]);
	private fired = new Set<string>();
	private seen = new Set<string>();
	private armed = new Set<string>();
	private notes: ReminderNote[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private clock: ReturnType<typeof setInterval> | null = null;
	private openNote: (id: string) => void = () => {};
	private attached = false;
	private hydrated = false;
	private readonly hydration: Promise<void>;

	constructor() {
		this.hydration = this.hydrateFired().finally(() => {
			this.hydrated = true;
			this.scan();
			this.arm();
		});
	}

	whenReady(): Promise<void> {
		return this.hydration;
	}

	attach(openNote: (id: string) => void): () => void {
		this.openNote = openNote;
		if (this.attached) return () => this.detach();
		this.attached = true;
		tickAppClock();
		this.clock = setInterval(() => {
			tickAppClock();
			this.scan();
			this.arm();
			void registerReminderDevice();
		}, 60_000);
		const onWake = () => {
			if (document.visibilityState === 'hidden') return;
			void this.hydrateFired().then(() => {
				tickAppClock();
				this.scan();
				this.arm();
				void registerReminderDevice();
			});
		};
		document.addEventListener('visibilitychange', onWake);
		window.addEventListener('focus', onWake);
		this.listenForNotificationClicks();
		void registerReminderDevice();
		return () => {
			document.removeEventListener('visibilitychange', onWake);
			window.removeEventListener('focus', onWake);
			this.detach();
		};
	}

	sync(notes: ReminderNote[]): void {
		this.notes = notes;
		this.fired = pruneFiredReminders(notes, this.fired);
		const current = new Set(relayReminderWakes(notes, Date.now()).map((wake) => wake.id));
		this.seen = new Set([...this.seen].filter((id) => current.has(id)));
		this.armed = new Set([...this.armed].filter((id) => current.has(id)));
		const kept = this.alerts.filter((alert) => {
			const note = notes.find((item) => item.id === alert.noteId);
			return note != null && note.reminder === alert.reminder && !note.archived && !note.trashed;
		});
		if (kept.length !== this.alerts.length) this.alerts = kept;
		if (!this.hydrated) return;
		this.scan();
		this.arm();
	}

	/** Publish only state that has completed cloud reconciliation. */
	publish(notes: ReminderNote[]): void {
		const candidateIds = new Set(relayReminderWakes(notes, Date.now()).map((wake) => wake.id));
		if (notificationPermission() === 'granted') this.armed = candidateIds;
		this.sync(notes);
		void Promise.all([publishReminderWakes(notes), registerReminderDevice()])
			.then(([wakes, registered]) => {
				if (wakes && registered) {
					this.armed = new Set(wakes.map((wake) => wake.id));
					return;
				}
				this.resetArmed(candidateIds);
			})
			.catch(() => {
				this.resetArmed(candidateIds);
			});
	}

	private resetArmed(candidateIds: Set<string>): void {
		this.armed = new Set();
		for (const id of candidateIds) this.seen.delete(id);
		this.scan();
	}

	dismiss(noteId: string): void {
		const alert = this.alerts.find((item) => item.noteId === noteId);
		if (alert) this.markFired(alert.wakeId);
		this.alerts = this.alerts.filter((item) => item.noteId !== noteId);
	}

	open(noteId: string): void {
		this.dismiss(noteId);
		this.openNote(noteId);
	}

	private addFallbackAlert(alert: ReminderAlert): void {
		if (!this.alerts.some((item) => item.wakeId === alert.wakeId)) {
			this.alerts = [...this.alerts, alert];
		}
		this.markFired(alert.wakeId);
	}

	private scan(): void {
		if (!this.hydrated) return;
		const due = unfiredDueReminders(this.notes, [...this.fired, ...this.seen], Date.now());
		for (const note of due) {
			const reminder = note.reminder as number;
			const wakeId = reminderWakeId(note.id, reminder);
			this.seen.add(wakeId);
			if (this.armed.has(wakeId)) continue;
			const alert: ReminderAlert = {
				wakeId,
				noteId: note.id,
				reminder,
				title: reminderPreview(note)
			};
			if (notificationPermission() !== 'granted') {
				this.addFallbackAlert(alert);
				continue;
			}
			void showReminderNotification(alert, () => this.open(note.id)).then((shown) => {
				if (shown) this.markFired(wakeId);
				else this.addFallbackAlert(alert);
			});
		}
	}

	private arm(): void {
		if (this.timer != null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const next = nextReminderAt(this.notes, Date.now());
		if (next == null) return;
		const delay = Math.min(Math.max(next - Date.now(), 0), MAX_TIMER_MS);
		this.timer = setTimeout(() => {
			this.timer = null;
			tickAppClock();
			this.scan();
			this.arm();
		}, delay);
	}

	private async hydrateFired(): Promise<void> {
		try {
			const stored = await getFiredReminderKeys();
			this.fired = new Set([...this.fired, ...stored]);
		} catch {
			/* IndexedDB may be unavailable in private browsing or tests. */
		}
	}

	private markFired(key: string): void {
		if (this.fired.has(key)) return;
		this.fired.add(key);
		void markFiredReminderKey(key).catch(() => undefined);
	}

	private onSwMessage = (event: MessageEvent) => {
		const data = event.data as { type?: string; noteId?: unknown } | null;
		if (data?.type !== 'open-note' || typeof data.noteId !== 'string') return;
		this.open(data.noteId);
	};

	private listenForNotificationClicks(): void {
		if (!('serviceWorker' in navigator)) return;
		navigator.serviceWorker.addEventListener('message', this.onSwMessage);
	}

	private detach(): void {
		this.attached = false;
		this.openNote = () => {};
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.removeEventListener('message', this.onSwMessage);
		}
		if (this.timer != null) clearTimeout(this.timer);
		if (this.clock != null) clearInterval(this.clock);
		this.timer = null;
		this.clock = null;
	}
}

export const reminderStore = new ReminderStore();
