import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReminderStore } from './reminders.svelte';
import { reminderWakeId, type ReminderNote } from '$lib/reminderNotify';
import { getFiredReminderKeys } from '$lib/db/idb';

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
	vi.unstubAllGlobals();
});

describe('ReminderStore', () => {
	it('raises an in-app alert when system notifications are unavailable', async () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		await vi.waitFor(() =>
			expect(store.alerts).toEqual([expect.objectContaining({ noteId: 'n1', title: 'Groceries' })])
		);
	});

	it('does not re-alert a reminder the user already dismissed', async () => {
		const store = new ReminderStore();
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		await vi.waitFor(() => expect(store.alerts).toHaveLength(1));
		store.dismiss('n1');
		store.sync([note({ reminder: 100 })]);
		expect(store.alerts).toEqual([]);
	});

	it('persists a system notification before displaying it and does not replay it after reload', async () => {
		const deliveredWithFiredKeys: string[][] = [];
		const showNotification = vi.fn(async () => {
			deliveredWithFiredKeys.push(await getFiredReminderKeys());
		});
		vi.stubGlobal('Notification', { permission: 'granted' });
		vi.stubGlobal('navigator', {
			serviceWorker: { ready: Promise.resolve({ showNotification }) }
		});

		const due = note({ id: 'reload-reminder', reminder: 100 });
		const wakeId = reminderWakeId(due.id, due.reminder as number);
		const firstLoad = new ReminderStore();
		firstLoad.sync([due]);
		await firstLoad.whenReady();
		await vi.waitFor(() => expect(showNotification).toHaveBeenCalledOnce());

		expect(deliveredWithFiredKeys).toEqual([[wakeId]]);

		const reloaded = new ReminderStore();
		reloaded.sync([due]);
		await reloaded.whenReady();
		expect(showNotification).toHaveBeenCalledOnce();
	});

	it('opens the note and clears the alert', async () => {
		const opened: string[] = [];
		const store = new ReminderStore();
		const stop = store.attach((id) => opened.push(id));
		store.sync([note({ reminder: 100 })]);
		await store.whenReady();
		await vi.waitFor(() => expect(store.alerts).toHaveLength(1));
		store.open('n1');
		expect(opened).toEqual(['n1']);
		expect(store.alerts).toEqual([]);
		stop();
	});

	it('fires a later reminder after the scheduled time', async () => {
		const now = Date.now();
		const store = new ReminderStore();
		store.sync([note({ reminder: now + 5_000 })]);
		await store.whenReady();
		expect(store.alerts).toEqual([]);
		vi.useFakeTimers({ now });
		store.sync([note({ reminder: now + 5_000 })]);
		await vi.advanceTimersByTimeAsync(5_000);
		await vi.waitFor(() => expect(store.alerts[0]?.noteId).toBe('n1'));
	});
});
