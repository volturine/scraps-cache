import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ReminderPicker from './ReminderPicker.svelte';

const reminder = new Date(2026, 7, 12, 15, 30, 0, 0).getTime();

afterEach(() => {
	vi.useRealTimers();
});

function monthName(month: number): string {
	return new Date(2020, month, 1).toLocaleDateString([], { month: 'long' });
}

describe('ReminderPicker date and time controls', () => {
	it('shows a 24-hour wheel and per-minute steps', () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		const hourOptions = screen
			.getByRole('listbox', { name: 'Hour' })
			.querySelectorAll('[role="option"]');
		expect(hourOptions).toHaveLength(24);
		expect(hourOptions[0].textContent).toBe('00');
		expect(hourOptions[23].textContent).toBe('23');
		expect(hourOptions[15].getAttribute('aria-selected')).toBe('true');
		expect(screen.queryByRole('listbox', { name: 'AM/PM' })).toBeNull();

		const minuteBox = screen.getByRole('listbox', { name: 'Minute' });
		const minuteOptions = minuteBox.querySelectorAll('[role="option"]');
		expect(minuteOptions).toHaveLength(60);
		expect(minuteOptions[0].textContent).toBe('00');
		expect(minuteOptions[1].textContent).toBe('01');
		expect(minuteOptions[59].textContent).toBe('59');
		expect(minuteOptions[30].getAttribute('aria-selected')).toBe('true');
	});

	it('opens day, month, and year wheels when the date label is pressed', async () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		expect(screen.queryByRole('listbox', { name: 'Month' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));

		const dayOptions = screen
			.getByRole('listbox', { name: 'Day' })
			.querySelectorAll('[role="option"]');
		expect(dayOptions).toHaveLength(31);
		expect(screen.getByRole('option', { name: '12' }).getAttribute('aria-selected')).toBe('true');
		const monthOptions = screen
			.getByRole('listbox', { name: 'Month' })
			.querySelectorAll('[role="option"]');
		expect(monthOptions).toHaveLength(12);
		expect(screen.getByRole('option', { name: monthName(7) }).getAttribute('aria-selected')).toBe(
			'true'
		);
		expect(screen.getByRole('listbox', { name: 'Year' })).toBeTruthy();
		expect(screen.getByRole('option', { name: '2026' }).getAttribute('aria-selected')).toBe('true');
		expect(screen.queryByRole('listbox', { name: 'Minute' })).toBeNull();
	});

	it('keeps day arrows independent of the month/year picker', async () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		await fireEvent.click(screen.getByRole('button', { name: 'Next day' }));

		expect(screen.getByRole('button', { name: 'Choose date' }).textContent).toContain('13');
		expect(screen.queryByRole('listbox', { name: 'Month' })).toBeNull();
	});

	it('applies a tapped month while clamping the day', async () => {
		const endOfMonth = new Date(2026, 7, 31, 9, 0, 0, 0).getTime();
		render(ReminderPicker, { props: { reminder: endOfMonth, onClose: () => {} } });

		await fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
		await fireEvent.click(screen.getByRole('option', { name: monthName(1) }));

		expect(screen.getByRole('button', { name: 'Choose date' }).textContent).toContain('28');
		expect(
			screen.getByRole('listbox', { name: 'Day' }).querySelectorAll('[role="option"]')
		).toHaveLength(28);
		expect(screen.getByRole('option', { name: monthName(1) }).getAttribute('aria-selected')).toBe(
			'true'
		);
	});

	it('changes the selected day from the day wheel', async () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		await fireEvent.click(screen.getByRole('button', { name: 'Choose date' }));
		await fireEvent.click(screen.getByRole('option', { name: '21' }));

		expect(screen.getByRole('button', { name: 'Choose date' }).textContent).toContain('21');
		expect(screen.getByRole('option', { name: '21' }).getAttribute('aria-selected')).toBe('true');
	});
});

describe('ReminderPicker remaining time', () => {
	it('shows time left and only the closed-app sync note', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 12, 14, 30, 0, 0));
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		expect(screen.getByText('in 1 hour')).toBeTruthy();
		expect(screen.queryByText(/Notifies on this device/)).toBeNull();
		expect(screen.getByText('Closed-app alerts need Sync on this device.')).toBeTruthy();
	});

	it('updates remaining time when the hour changes', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 12, 14, 30, 0, 0));
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		await fireEvent.click(
			within(screen.getByRole('listbox', { name: 'Hour' })).getByRole('option', { name: '16' })
		);

		expect(screen.getByText('in 2 hours')).toBeTruthy();
	});

	it('counts down while the picker stays open', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 12, 14, 29, 0, 0));
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		expect(screen.getByText('in 1 hour 1 minute')).toBeTruthy();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(screen.getByText('in 1 hour')).toBeTruthy();
	});
});
