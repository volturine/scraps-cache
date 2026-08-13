import { tickAppClock } from '$lib/appClock.svelte';
import { getFiredReminderKeys, setFiredReminderKeys } from '$lib/db/idb';
import {
	nextReminderAt,
	pruneFiredReminders,
	readFiredReminders,
	reminderNotifyKey,
	reminderPreview,
	showReminderNotification,
	unfiredDueReminders,
	writeFiredReminders,
	type ReminderAlert,
	type ReminderNote
} from '$lib/reminderNotify';
import { syncReminderWakes } from '$lib/reminderWake';

const MAX_TIMER_MS = 60_000;
const WAKE_DEBOUNCE_MS = 800;

export class ReminderStore {
	alerts = $state<ReminderAlert[]>([]);
	private fired = new Set<string>(readFiredReminders());
	private seen = new Set<string>();
	private notes: ReminderNote[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private wakeTimer: ReturnType<typeof setTimeout> | null = null;
	private clock: ReturnType<typeof setInterval> | null = null;
	private openNote: (id: string) => void = () => {};
	private attached = false;

	attach(openNote: (id: string) => void): () => void {
		this.openNote = openNote;
		if (this.attached) return () => this.detach();
		this.attached = true;
		tickAppClock();
		this.clock = setInterval(() => {
			tickAppClock();
			this.scan();
			this.arm();
		}, 15_000);
		void this.hydrateFired();
		const onWake = () => {
			if (document.visibilityState === 'hidden') return;
			void this.hydrateFired().then(() => {
				tickAppClock();
				this.scan();
				this.arm();
			});
		};
		document.addEventListener('visibilitychange', onWake);
		window.addEventListener('focus', onWake);
		this.listenForNotificationClicks();
		this.queueWakeSync();
		return () => {
			document.removeEventListener('visibilitychange', onWake);
			window.removeEventListener('focus', onWake);
			this.detach();
		};
	}

	sync(notes: ReminderNote[]): void {
		this.notes = notes;
		this.fired = pruneFiredReminders(notes, this.fired);
		this.alerts = this.alerts.filter((alert) => {
			const note = notes.find((item) => item.id === alert.noteId);
			return note != null && note.reminder === alert.reminder && !note.archived && !note.trashed;
		});
		this.scan();
		this.arm();
		if (this.attached) this.queueWakeSync();
	}

	dismiss(noteId: string): void {
		const alert = this.alerts.find((item) => item.noteId === noteId);
		if (alert) this.markFired(reminderNotifyKey(noteId, alert.reminder));
		this.alerts = this.alerts.filter((item) => item.noteId !== noteId);
	}

	open(noteId: string): void {
		this.dismiss(noteId);
		this.openNote(noteId);
	}

	private scan(): void {
		tickAppClock();
		const due = unfiredDueReminders(this.notes, [...this.fired, ...this.seen], Date.now());
		if (due.length === 0) return;
		const nextAlerts = [...this.alerts];
		for (const note of due) {
			const reminder = note.reminder as number;
			const key = reminderNotifyKey(note.id, reminder);
			this.seen.add(key);
			const alert: ReminderAlert = {
				noteId: note.id,
				reminder,
				title: reminderPreview(note)
			};
			if (!nextAlerts.some((item) => item.noteId === note.id && item.reminder === reminder)) {
				nextAlerts.push(alert);
			}
			void showReminderNotification(alert, () => this.open(note.id)).then((shown) => {
				if (shown) this.markFired(key);
			});
		}
		this.alerts = nextAlerts;
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

	private queueWakeSync(): void {
		if (this.wakeTimer != null) clearTimeout(this.wakeTimer);
		this.wakeTimer = setTimeout(() => {
			this.wakeTimer = null;
			void syncReminderWakes(this.notes);
		}, WAKE_DEBOUNCE_MS);
	}

	private async hydrateFired(): Promise<void> {
		try {
			const stored = await getFiredReminderKeys();
			if (stored.length === 0) return;
			this.fired = new Set([...this.fired, ...stored]);
		} catch {
			/* IndexedDB may be unavailable in tests. */
		}
	}

	private markFired(key: string): void {
		if (this.fired.has(key)) return;
		this.fired.add(key);
		writeFiredReminders(this.fired);
		void setFiredReminderKeys(this.fired).catch(() => undefined);
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
		if (this.timer != null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.wakeTimer != null) {
			clearTimeout(this.wakeTimer);
			this.wakeTimer = null;
		}
		if (this.clock != null) {
			clearInterval(this.clock);
			this.clock = null;
		}
	}
}

export const reminderStore = new ReminderStore();
