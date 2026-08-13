import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ReminderLabel from './ReminderLabel.svelte';

const future = Date.now() + 60 * 60 * 1000;
const past = Date.now() - 60 * 60 * 1000;

describe('ReminderLabel', () => {
	it('uses the muted strip for an upcoming reminder', () => {
		const { container } = render(ReminderLabel, { props: { reminder: future } });
		const label = container.querySelector('[aria-label^="Reminder,"]');
		expect(label).toBeTruthy();
		expect(label?.className).toContain('bg-black/5');
		expect(label?.className).not.toContain('bg-rose-600');
	});

	it('uses a high-contrast overdue strip for a past reminder', () => {
		const { container } = render(ReminderLabel, { props: { reminder: past } });
		const label = container.querySelector('[aria-label^="Overdue reminder,"]');
		expect(label).toBeTruthy();
		expect(label?.className).toContain('bg-rose-600');
		expect(label?.querySelector('svg')).toBeTruthy();
	});

	it('keeps chip and inline variants overdue-visible', () => {
		const chip = render(ReminderLabel, { props: { reminder: past, variant: 'chip' } });
		expect(chip.container.querySelector('[aria-label^="Overdue reminder,"]')?.className).toContain(
			'bg-rose-600'
		);

		const inline = render(ReminderLabel, { props: { reminder: past, variant: 'inline' } });
		expect(
			inline.container.querySelector('[aria-label^="Overdue reminder,"]')?.className
		).toContain('text-rose-700');
	});
});
