import { describe, expect, it } from 'vitest';
import { dayKey, formatReminderCountdown, isReminderOverdue } from './utils';

describe('dayKey', () => {
	it('formats an epoch timestamp as a zero-padded local date', () => {
		expect(dayKey(new Date(2026, 7, 13, 6, 48).getTime())).toBe('2026-08-13');
	});

	it('pads single-digit months and days', () => {
		expect(dayKey(new Date(2026, 0, 5).getTime())).toBe('2026-01-05');
	});
});

describe('isReminderOverdue', () => {
	const now = new Date(2026, 7, 13, 6, 48, 0, 0).getTime();

	it('is false when no reminder is set', () => {
		expect(isReminderOverdue(null, now)).toBe(false);
	});

	it('is false when the reminder is still in the future', () => {
		expect(isReminderOverdue(now + 60_000, now)).toBe(false);
	});

	it('is false when the reminder is exactly now', () => {
		expect(isReminderOverdue(now, now)).toBe(false);
	});

	it('is true when the reminder is in the past', () => {
		expect(isReminderOverdue(now - 1, now)).toBe(true);
	});
});

describe('formatReminderCountdown', () => {
	const now = new Date(2026, 7, 13, 6, 48, 0, 0).getTime();

	it('marks a past reminder as overdue', () => {
		expect(formatReminderCountdown(now - 1, now)).toBe('Overdue');
	});

	it('marks a reminder that is due this second as due now', () => {
		expect(formatReminderCountdown(now, now)).toBe('Due now');
		expect(formatReminderCountdown(now + 999, now)).toBe('Due now');
	});

	it('uses seconds under a minute', () => {
		expect(formatReminderCountdown(now + 1_000, now)).toBe('in 1 second');
		expect(formatReminderCountdown(now + 45_000, now)).toBe('in 45 seconds');
	});

	it('uses minutes under an hour', () => {
		expect(formatReminderCountdown(now + 60_000, now)).toBe('in 1 minute');
		expect(formatReminderCountdown(now + 12 * 60_000 + 30_000, now)).toBe('in 12 minutes');
	});

	it('uses hours and leftover minutes under a day', () => {
		expect(formatReminderCountdown(now + 3_600_000, now)).toBe('in 1 hour');
		expect(formatReminderCountdown(now + 2 * 3_600_000 + 15 * 60_000, now)).toBe(
			'in 2 hours 15 minutes'
		);
	});

	it('uses days and leftover hours', () => {
		expect(formatReminderCountdown(now + 86_400_000, now)).toBe('in 1 day');
		expect(formatReminderCountdown(now + 3 * 86_400_000 + 4 * 3_600_000, now)).toBe(
			'in 3 days 4 hours'
		);
	});

	it('uses months and leftover days', () => {
		expect(formatReminderCountdown(new Date(2026, 8, 13, 6, 48, 0, 0).getTime(), now)).toBe(
			'in 1 month'
		);
		expect(formatReminderCountdown(new Date(2026, 9, 18, 10, 48, 0, 0).getTime(), now)).toBe(
			'in 2 months 5 days'
		);
	});

	it('uses years and leftover months', () => {
		expect(formatReminderCountdown(new Date(2027, 7, 13, 6, 48, 0, 0).getTime(), now)).toBe(
			'in 1 year'
		);
		expect(formatReminderCountdown(new Date(2028, 10, 13, 6, 48, 0, 0).getTime(), now)).toBe(
			'in 2 years 3 months'
		);
	});
});
