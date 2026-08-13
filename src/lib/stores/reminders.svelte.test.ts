import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReminderStore } from './reminders.svelte';
import type { ReminderNote } from '$lib/reminderNotify';

function note(partial: Partial<ReminderNote> = {}): ReminderNote {
	return {
		id: 'n1',
		title: 'Groceries',
		body: '',
		reminder: Date.now() - 1,
		archived: false,
		trashed: false,
		...partial
	};
}

afterEach(() => {
	localStorage.removeItem('gkc-fired-reminders');
	vi.useRealTimers();
});

describe('ReminderStore', () => {
	it('raises an in-app alert when a reminder is due', () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		expect(store.alerts).toEqual([expect.objectContaining({ noteId: 'n1', title: 'Groceries' })]);
	});

	it('does not re-alert a reminder the user already dismissed', () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		store.dismiss('n1');
		store.sync([note({ reminder: 100 })]);
		expect(store.alerts).toEqual([]);
	});

	it('opens the note and clears the alert', () => {
		const opened: string[] = [];
		const store = new ReminderStore();
		const stop = store.attach((id) => opened.push(id));
		store.sync([note({ reminder: 100 })]);
		store.open('n1');
		expect(opened).toEqual(['n1']);
		expect(store.alerts).toEqual([]);
		stop();
	});

	it('fires a later reminder after the scheduled time', () => {
		vi.useFakeTimers();
		const now = Date.now();
		const store = new ReminderStore();
		store.sync([note({ reminder: now + 5_000 })]);
		expect(store.alerts).toEqual([]);
		vi.advanceTimersByTime(5_000);
		expect(store.alerts[0]?.noteId).toBe('n1');
	});
});
