// Local reminder display. The relay may store wake timestamps, never note text.
import { formatReminder } from './utils';

export type ReminderNote = {
	id: string;
	title: string;
	body: string;
	reminder: number | null;
	archived: boolean;
	trashed: boolean;
};

export type ReminderAlert = {
	noteId: string;
	reminder: number;
	title: string;
};

const FIRED_KEY = 'gkc-fired-reminders';
const CHECKLIST_PREFIX = /^(?:\s*(?:[-*•]\s+)?)?\[[ xX]?\]\s*/;

export function reminderNotifyKey(noteId: string, reminder: number): string {
	return `${noteId}:${reminder}`;
}

export function reminderPreview(note: Pick<ReminderNote, 'title' | 'body'>): string {
	const title = note.title.trim();
	if (title) return title;
	for (const raw of (note.body ?? '').split('\n')) {
		const line = raw.replace(CHECKLIST_PREFIX, '').trim();
		if (line) return line.slice(0, 80);
	}
	return 'Untitled note';
}

export function dueReminderNotes(notes: ReminderNote[], now: number): ReminderNote[] {
	return notes.filter(
		(note) => !note.archived && !note.trashed && note.reminder != null && note.reminder <= now
	);
}

export const RELAY_WAKE_RETAIN_MS = 24 * 60 * 60 * 1000;

export function futureWakeTimes(notes: ReminderNote[], now: number, limit = 50): number[] {
	const times = new Set<number>();
	for (const note of notes) {
		if (note.archived || note.trashed || note.reminder == null || note.reminder <= now) continue;
		times.add(note.reminder);
	}
	return [...times].sort((left, right) => left - right).slice(0, limit);
}

/** Timestamps the relay may store: upcoming, plus due times still within the retain window. */
export function relayWakeTimes(notes: ReminderNote[], now: number, limit = 50): number[] {
	const earliest = now - RELAY_WAKE_RETAIN_MS;
	const times = new Set<number>();
	for (const note of notes) {
		if (note.archived || note.trashed || note.reminder == null) continue;
		if (note.reminder <= earliest) continue;
		times.add(note.reminder);
	}
	return [...times].sort((left, right) => left - right).slice(0, limit);
}

export function nextReminderAt(notes: ReminderNote[], now: number): number | null {
	let next: number | null = null;
	for (const note of notes) {
		if (note.archived || note.trashed || note.reminder == null || note.reminder <= now) continue;
		if (next == null || note.reminder < next) next = note.reminder;
	}
	return next;
}

export function unfiredDueReminders(
	notes: ReminderNote[],
	fired: Iterable<string>,
	now: number
): ReminderNote[] {
	const seen = fired instanceof Set ? fired : new Set(fired);
	return dueReminderNotes(notes, now).filter(
		(note) => !seen.has(reminderNotifyKey(note.id, note.reminder as number))
	);
}

export function pruneFiredReminders(notes: ReminderNote[], fired: Iterable<string>): Set<string> {
	const known = new Map(notes.map((note) => [note.id, note]));
	const next = new Set<string>();
	for (const key of fired) {
		const split = key.lastIndexOf(':');
		if (split < 0) continue;
		const id = key.slice(0, split);
		const reminder = Number(key.slice(split + 1));
		if (!Number.isFinite(reminder)) continue;
		const note = known.get(id);
		if (!note) {
			next.add(key);
			continue;
		}
		if (note.reminder === reminder) next.add(key);
	}
	return next;
}

export function readFiredReminders(): Set<string> {
	if (typeof localStorage === 'undefined') return new Set();
	try {
		const raw = localStorage.getItem(FIRED_KEY);
		if (!raw) return new Set();
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((item): item is string => typeof item === 'string'));
	} catch {
		return new Set();
	}
}

export function writeFiredReminders(fired: Iterable<string>): void {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(FIRED_KEY, JSON.stringify([...fired]));
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
	if (typeof Notification === 'undefined') return 'unsupported';
	return Notification.permission;
}

export async function requestReminderPermission(): Promise<NotificationPermission | 'unsupported'> {
	if (typeof Notification === 'undefined') return 'unsupported';
	if (Notification.permission !== 'default') return Notification.permission;
	try {
		return await Notification.requestPermission();
	} catch {
		return 'denied';
	}
}

export async function showReminderNotification(
	alert: ReminderAlert,
	onClick?: () => void
): Promise<boolean> {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
	const payload: NotificationOptions = {
		body: formatReminder(alert.reminder),
		tag: `shard-reminder:${alert.noteId}`,
		icon: '/icon-192.png',
		data: { type: 'reminder', noteId: alert.noteId }
	};
	try {
		const registration = await navigator.serviceWorker?.ready.catch(() => undefined);
		if (registration) {
			await registration.showNotification(alert.title, payload);
			return true;
		}
		const notification = new Notification(alert.title, payload);
		notification.onclick = () => {
			onClick?.();
			notification.close();
			window.focus();
		};
		return true;
	} catch {
		return false;
	}
}
