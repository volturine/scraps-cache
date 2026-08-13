import { describe, expect, it } from 'vitest';
import { isReminderOverdue } from './utils';

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
