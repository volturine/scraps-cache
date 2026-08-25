import { describe, expect, it } from 'vitest';
import { recordTag, sha256 } from './syncHash';

describe('keyed sync content tags', () => {
	it('is deterministic for owners but separated across sync keys', async () => {
		const payload = { kind: 'label', value: { id: 'label-1', name: 'Work' } };
		const first = await recordTag('sync-key-one', payload);

		expect(await recordTag('sync-key-one', payload)).toBe(first);
		expect(await recordTag('sync-key-two', payload)).not.toBe(first);
		expect(await sha256(payload)).not.toBe(first);
	});
});
