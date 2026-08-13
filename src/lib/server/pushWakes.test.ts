import { describe, expect, it } from 'vitest';
import { isHttpsEndpoint, isPushSubscription, parseFireAt } from './pushWakes';
import { MAX_WAKES_PER_DEVICE } from './syncStore';

describe('blind wake request validation', () => {
	it('accepts an https push endpoint and subscription keys', () => {
		expect(isHttpsEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
		expect(isHttpsEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false);
		expect(
			isPushSubscription({
				endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/token',
				keys: { p256dh: 'B'.repeat(20), auth: 'a'.repeat(16) }
			})
		).toBe(true);
	});

	it('keeps only future wake timestamps and rejects oversized batches', () => {
		expect(parseFireAt([50, 150, 150], 100)).toEqual([150, 150]);
		expect(parseFireAt(['150'], 100)).toBeNull();
		expect(
			parseFireAt(
				Array.from({ length: MAX_WAKES_PER_DEVICE + 1 }, (_, i) => i + 200),
				100
			)
		).toBe(null);
	});
});
