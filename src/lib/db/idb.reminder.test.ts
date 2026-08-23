import { describe, expect, it } from 'vitest';
import { claimFiredReminderKey, getFiredReminderKeys } from './idb';

describe('reminder delivery claims', () => {
	it('allows only one concurrent claim for a wake id', async () => {
		const wakeId = 'a'.repeat(43);
		const claims = await Promise.all([
			claimFiredReminderKey(wakeId),
			claimFiredReminderKey(wakeId)
		]);

		expect(claims.sort()).toEqual([false, true]);
		expect(await getFiredReminderKeys()).toEqual([wakeId]);
	});
});
