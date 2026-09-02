import { afterEach, describe, expect, it } from 'vitest';
import { getMeta, setMetaIfAbsent } from './db';
import { cleanupTestDbs, testDb } from './testDb';

afterEach(() => cleanupTestDbs());

describe('server database metadata', () => {
	it('selects one stable winner during concurrent initialization', async () => {
		const db = testDb();
		const candidates = Array.from({ length: 20 }, (_, index) => `candidate-${index}`);
		const winners = await Promise.all(
			candidates.map((candidate) => setMetaIfAbsent(db, 'singleton', candidate))
		);

		expect(new Set(winners).size).toBe(1);
		expect(await getMeta(db, 'singleton')).toBe(winners[0]);
	});
});
