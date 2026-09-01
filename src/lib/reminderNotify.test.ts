import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	dueReminderNotes,
	nextReminderAt,
	relayReminderWakes,
	RELAY_WAKE_RETAIN_MS,
	reminderPreview,
	reminderWakeId,
	requestReminderPermission,
	showReminderNotification,
	unfiredDueReminders
} from './reminderNotify';

function note(
	partial: Partial<{
		id: string;
		title: string;
		body: string;
		reminder: number | null;
		archived: boolean;
		trashed: boolean;
	}> = {}
) {
	return {
		id: '550e8400-e29b-41d4-a716-446655440000',
		title: 'Groceries',
		body: '',
		reminder: 100,
		archived: false,
		trashed: false,
		...partial
	};
}

describe('reminderPreview', () => {
	it('uses title, body fallback, and an untitled fallback', () => {
		expect(reminderPreview({ title: ' Buy milk ', body: 'ignored' })).toBe('Buy milk');
		expect(reminderPreview({ title: '', body: '\n[ ] Pick up oat milk\nmore' })).toBe(
			'Pick up oat milk'
		);
		expect(reminderPreview({ title: '', body: '   \n[ ]   ' })).toBe('Untitled note');
	});

	it('strips markdown bullet markers from body previews', () => {
		expect(reminderPreview({ title: '', body: '- Oat milk' })).toBe('Oat milk');
		expect(reminderPreview({ title: '', body: '  * Oat milk' })).toBe('Oat milk');
		expect(reminderPreview({ title: '', body: '+ [ ] Oat milk' })).toBe('Oat milk');
		expect(reminderPreview({ title: '', body: 'plain - text' })).toBe('plain - text');
	});
});

describe('reminder wake identity and scheduling', () => {
	const now = 1_000;

	it('derives one stable opaque id per note and scheduled time', () => {
		const first = reminderWakeId('note-a', 10);
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(reminderWakeId('note-a', 10)).toBe(first);
		expect(reminderWakeId('note-a', 11)).not.toBe(first);
		expect(reminderWakeId('note-b', 10)).not.toBe(first);
	});

	it('keeps distinct reminders at the same timestamp', () => {
		const wakes = relayReminderWakes(
			[note({ id: 'note-a', reminder: now + 10 }), note({ id: 'note-b', reminder: now + 10 })],
			now
		);
		expect(wakes).toHaveLength(2);
		expect(new Set(wakes.map((wake) => wake.id)).size).toBe(2);
		expect(wakes.map((wake) => wake.fireAt)).toEqual([now + 10, now + 10]);
	});

	it('uploads upcoming and recently due wakes but excludes stale and hidden notes', () => {
		const wakes = relayReminderWakes(
			[
				note({ id: 'due', reminder: now }),
				note({ id: 'soon', reminder: now + 10 }),
				note({ id: 'old', reminder: now - RELAY_WAKE_RETAIN_MS }),
				note({ id: 'arch', reminder: now, archived: true })
			],
			now
		);
		expect(wakes.map((wake) => wake.fireAt)).toEqual([now, now + 10]);
	});

	it('detects due reminders and skips a fired wake id', () => {
		const due = note({ reminder: now });
		expect(dueReminderNotes([due], now)).toEqual([due]);
		expect(unfiredDueReminders([due], [reminderWakeId(due.id, now)], now)).toEqual([]);
		expect(unfiredDueReminders([due], [], now)).toEqual([due]);
	});

	it('finds the soonest future reminder', () => {
		expect(
			nextReminderAt(
				[note({ id: 'a', reminder: now + 50 }), note({ id: 'b', reminder: now + 10 })],
				now
			)
		).toBe(now + 10);
		expect(nextReminderAt([note({ reminder: now })], now)).toBeNull();
	});
});

describe('system notifications', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('requests permission only while it is still default', async () => {
		const requestPermission = vi.fn().mockResolvedValue('granted');
		vi.stubGlobal('Notification', { permission: 'default', requestPermission });
		await expect(requestReminderPermission()).resolves.toBe('granted');
		expect(requestPermission).toHaveBeenCalledOnce();
	});

	it('uses the wake id as the notification dedupe tag', async () => {
		const show = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('navigator', {
			serviceWorker: { ready: Promise.resolve({ showNotification: show }) }
		});
		const wakeId = reminderWakeId('n1', 1);
		await expect(
			showReminderNotification({ wakeId, noteId: 'n1', reminder: 1, title: 'Groceries' })
		).resolves.toBe(true);
		expect(show).toHaveBeenCalledWith(
			'Groceries',
			expect.objectContaining({
				tag: `scrapscache-reminder:${wakeId}`,
				data: { type: 'reminder', noteId: 'n1', wakeId }
			})
		);
	});

	it('does not show a system notification without permission', async () => {
		vi.stubGlobal('Notification', { permission: 'denied' });
		await expect(
			showReminderNotification({
				wakeId: reminderWakeId('n1', 1),
				noteId: 'n1',
				reminder: 1,
				title: 'Groceries'
			})
		).resolves.toBe(false);
	});
});
