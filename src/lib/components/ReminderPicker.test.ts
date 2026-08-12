import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ReminderPicker from './ReminderPicker.svelte';

const reminder = new Date(2026, 7, 12, 15, 30, 0, 0).getTime();

function monthName(month: number): string {
	return new Date(2020, month, 1).toLocaleDateString([], { month: 'long' });
}

describe('ReminderPicker date and time controls', () => {
	it('shows a per-minute time wheel instead of 15-minute steps', () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		const minuteOptions = screen.getByRole('listbox', { name: 'Minute' }).querySelectorAll('[role="option"]');
		expect(minuteOptions).toHaveLength(60);
		expect(minuteOptions[0].textContent).toBe('00');
		expect(minuteOptions[1].textContent).toBe('01');
		expect(minuteOptions[59].textContent).toBe('59');
		expect(screen.getByRole('option', { name: '30' }).getAttribute('aria-selected')).toBe('true');
	});

	it('opens month and year wheels when the date label is pressed', async () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		expect(screen.queryByRole('listbox', { name: 'Month' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Choose month and year' }));

		const monthOptions = screen.getByRole('listbox', { name: 'Month' }).querySelectorAll('[role="option"]');
		expect(monthOptions).toHaveLength(12);
		expect(screen.getByRole('option', { name: monthName(7) }).getAttribute('aria-selected')).toBe('true');
		expect(screen.getByRole('listbox', { name: 'Year' })).toBeTruthy();
		expect(screen.getByRole('option', { name: '2026' }).getAttribute('aria-selected')).toBe('true');
		expect(screen.queryByRole('listbox', { name: 'Minute' })).toBeNull();
	});

	it('keeps day arrows independent of the month/year picker', async () => {
		render(ReminderPicker, { props: { reminder, onClose: () => {} } });

		await fireEvent.click(screen.getByRole('button', { name: 'Next day' }));

		expect(screen.getByRole('button', { name: 'Choose month and year' }).textContent).toContain('13');
		expect(screen.queryByRole('listbox', { name: 'Month' })).toBeNull();
	});

	it('applies a tapped month while clamping the day', async () => {
		const endOfMonth = new Date(2026, 7, 31, 9, 0, 0, 0).getTime();
		render(ReminderPicker, { props: { reminder: endOfMonth, onClose: () => {} } });

		await fireEvent.click(screen.getByRole('button', { name: 'Choose month and year' }));
		await fireEvent.click(screen.getByRole('option', { name: monthName(1) }));

		expect(screen.getByRole('button', { name: 'Choose month and year' }).textContent).toContain('28');
		expect(screen.getByRole('option', { name: monthName(1) }).getAttribute('aria-selected')).toBe('true');
	});
});
