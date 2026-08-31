// Local reminder display. The relay receives only opaque wake ids and timestamps.
import { sha256 } from '@noble/hashes/sha2.js';
import { formatReminder } from './utils';

export type ReminderNote = {
	id: string;
	title: string;
	body: string;
	reminder: number | null;
	archived: boolean;
	trashed: boolean;
};

export type ReminderWake = {
	id: string;
	fireAt: number;
};

export type ReminderAlert = {
	wakeId: string;
	noteId: string;
	reminder: number;
	title: string;
};

const CHECKLIST_PREFIX = /^(?:\s*(?:[-*•]\s+)?)?\[[ xX]?\]\s*/;
const WAKE_DOMAIN = 'scraps-cache-reminder-wake:v1\0';
export const RELAY_WAKE_RETAIN_MS = 24 * 60 * 60 * 1000;
export const MAX_RELAY_WAKES = 1_000;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** Stable across synced devices without exposing the random note id to the relay. */
export function reminderWakeId(noteId: string, reminder: number): string {
	return bytesToBase64Url(sha256(new TextEncoder().encode(`${WAKE_DOMAIN}${noteId}\0${reminder}`)));
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

/** Upcoming wakes plus recently due wakes, sorted so the relay cap retains the nearest work. */
export function relayReminderWakes(
	notes: ReminderNote[],
	now: number,
	limit = MAX_RELAY_WAKES
): ReminderWake[] {
	const earliest = now - RELAY_WAKE_RETAIN_MS;
	const wakes = new Map<string, ReminderWake>();
	for (const note of notes) {
		if (note.archived || note.trashed || note.reminder == null || note.reminder <= earliest)
			continue;
		const id = reminderWakeId(note.id, note.reminder);
		wakes.set(id, { id, fireAt: note.reminder });
	}
	return [...wakes.values()]
		.sort((left, right) => left.fireAt - right.fireAt || left.id.localeCompare(right.id))
		.slice(0, limit);
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
		(note) => !seen.has(reminderWakeId(note.id, note.reminder as number))
	);
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
		tag: `scrapscache-reminder:${alert.wakeId}`,
		icon: '/icon-192.png',
		data: { type: 'reminder', noteId: alert.noteId, wakeId: alert.wakeId }
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
