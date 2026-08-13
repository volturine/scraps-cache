import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	dueReminderNotes,
	nextReminderAt,
	pruneFiredReminders,
	readFiredReminders,
	reminderNotifyKey,
	reminderPreview,
	requestReminderPermission,
	showReminderNotification,
	unfiredDueReminders,
	writeFiredReminders
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
		id: 'n1',
		title: 'Groceries',
		body: '',
		reminder: 100,
		archived: false,
		trashed: false,
		...partial
	};
}

describe('reminderPreview', () => {
	it('prefers the title', () => {
		expect(reminderPreview({ title: ' Buy milk ', body: 'ignored' })).toBe('Buy milk');
	});

	it('falls back to the first non-empty body line without checklist markup', () => {
		expect(reminderPreview({ title: '  ', body: '\n[ ] Pick up oat milk\nmore' })).toBe(
			'Pick up oat milk'
		);
	});

	it('uses Untitled note when there is no text', () => {
		expect(reminderPreview({ title: '', body: '   \n[ ]   ' })).toBe('Untitled note');
	});
});

describe('due and upcoming reminders', () => {
	const now = 1_000;

	it('treats a reminder at exactly now as due', () => {
		expect(dueReminderNotes([note({ reminder: now })], now)).toHaveLength(1);
	});

	it('ignores future, archived, and trashed notes', () => {
		expect(
			dueReminderNotes(
				[
					note({ id: 'future', reminder: now + 1 }),
					note({ id: 'arch', reminder: now, archived: true }),
					note({ id: 'trash', reminder: now, trashed: true }),
					note({ id: 'none', reminder: null })
				],
				now
			)
		).toEqual([]);
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

	it('skips reminders that already fired for this note and time', () => {
		const due = note({ reminder: now });
		expect(unfiredDueReminders([due], [reminderNotifyKey(due.id, now)], now)).toEqual([]);
		expect(unfiredDueReminders([due], [], now)).toEqual([due]);
	});
});

describe('pruneFiredReminders', () => {
	it('drops a key when the reminder was cleared or rescheduled', () => {
		const oldKey = reminderNotifyKey('n1', 100);
		const nextKey = reminderNotifyKey('n1', 200);
		expect([...pruneFiredReminders([note({ reminder: null })], [oldKey])]).toEqual([]);
		expect([...pruneFiredReminders([note({ reminder: 200 })], [oldKey, nextKey])]).toEqual([
			nextKey
		]);
	});

	it('keeps keys for notes that are not loaded yet', () => {
		const key = reminderNotifyKey('missing', 100);
		expect([...pruneFiredReminders([], [key])]).toEqual([key]);
	});
});

describe('fired reminder persistence', () => {
	afterEach(() => {
		localStorage.removeItem('gkc-fired-reminders');
	});

	it('round-trips keys and ignores corrupt storage', () => {
		writeFiredReminders(['a:1', 'b:2']);
		expect([...readFiredReminders()]).toEqual(['a:1', 'b:2']);
		localStorage.setItem('gkc-fired-reminders', '{');
		expect(readFiredReminders().size).toBe(0);
	});
});

describe('system notifications', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('requests permission only while it is still default', async () => {
		const requestPermission = vi.fn().mockResolvedValue('granted');
		vi.stubGlobal('Notification', {
			permission: 'default',
			requestPermission
		});
		await expect(requestReminderPermission()).resolves.toBe('granted');
		expect(requestPermission).toHaveBeenCalledOnce();
	});

	it('shows a tagged notification with the note title', async () => {
		const show = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('navigator', {
			serviceWorker: { ready: Promise.resolve({ showNotification: show }) }
		});
		await expect(
			showReminderNotification({ noteId: 'n1', reminder: 1, title: 'Groceries' })
		).resolves.toBe(true);
		expect(show).toHaveBeenCalledWith(
			'Groceries',
			expect.objectContaining({
				tag: 'shard-reminder:n1',
				data: { type: 'reminder', noteId: 'n1' }
			})
		);
	});

	it('does not show a system notification without permission', async () => {
		vi.stubGlobal('Notification', { permission: 'denied' });
		await expect(
			showReminderNotification({ noteId: 'n1', reminder: 1, title: 'Groceries' })
		).resolves.toBe(false);
	});
});
