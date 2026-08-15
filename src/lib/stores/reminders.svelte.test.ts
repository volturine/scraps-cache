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
	vi.useRealTimers();
});

describe('ReminderStore', () => {
	it('raises an in-app alert when system notifications are unavailable', async () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		expect(store.alerts).toEqual([expect.objectContaining({ noteId: 'n1', title: 'Groceries' })]);
	});

	it('does not re-alert a reminder the user already dismissed', async () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		store.dismiss('n1');
		store.sync([note({ reminder: 100 })]);
		expect(store.alerts).toEqual([]);
	});

	it('opens the note and clears the alert', async () => {
		const opened: string[] = [];
		const store = new ReminderStore();
		const stop = store.attach((id) => opened.push(id));
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		store.open('n1');
		expect(opened).toEqual(['n1']);
		expect(store.alerts).toEqual([]);
		stop();
	});

	it('fires a later reminder after the scheduled time', async () => {
		vi.useFakeTimers();
		const now = Date.now();
		const store = new ReminderStore();
		store.sync([note({ reminder: now + 5_000 })]);
		await store.whenReady();
		expect(store.alerts).toEqual([]);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(store.alerts[0]?.noteId).toBe('n1');
	});
});
