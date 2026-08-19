import { describe, expect, it } from 'vitest';
import { isHttpsEndpoint, isPushSubscription, parseReminderWakes } from './pushWakes';
import { MAX_WAKES_PER_ACCOUNT } from './syncStore';

const wakeId = (character: string) => character.repeat(43);

describe('blind wake request validation', () => {
	it('accepts an https push endpoint and subscription keys', () => {
		expect(isHttpsEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
		expect(isHttpsEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
		expect(isHttpsEndpoint('https://127.0.0.1/push/abcdef')).toBe(false);
		expect(isHttpsEndpoint('https://169.254.169.254/push')).toBe(false);
		expect(isHttpsEndpoint('https://[::1]/push/abcdef')).toBe(false);
		expect(isHttpsEndpoint('https://localhost/push/abcdef')).toBe(false);
		expect(
			isPushSubscription({
				endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/token',
				keys: { p256dh: 'B'.repeat(20), auth: 'a'.repeat(16) }
			})
		).toBe(true);
	});

	it('validates, sorts, and retains recently due opaque wakes', () => {
		expect(
			parseReminderWakes(
				[
					{ id: wakeId('b'), fireAt: 150 },
					{ id: wakeId('a'), fireAt: 50 }
				],
				100
			)
		).toEqual([
			{ id: wakeId('a'), fireAt: 50 },
			{ id: wakeId('b'), fireAt: 150 }
		]);
		expect(parseReminderWakes([{ id: 'not-opaque', fireAt: 150 }], 100)).toBeNull();
		expect(
			parseReminderWakes(
				Array.from({ length: MAX_WAKES_PER_ACCOUNT + 1 }, (_, index) => ({
					id: index.toString(36).padStart(43, 'a').slice(-43),
					fireAt: index + 200
				})),
				100
			)
		).toBeNull();
	});

	it('rejects duplicate wake ids instead of conflating reminders', () => {
		expect(
			parseReminderWakes(
				[
					{ id: wakeId('a'), fireAt: 100 },
					{ id: wakeId('a'), fireAt: 200 }
				],
				100
			)
		).toBeNull();
	});
});
