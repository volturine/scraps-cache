import { describe, expect, it, afterEach, vi } from 'vitest';
import { TokenBucketLimiter, checkAdminApiLimit } from './rateLimit';
import { testDb, cleanupTestDbs } from './testDb';
import type { Db } from './db';

let mockDb: Db;

vi.mock('$lib/server/db', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./db')>();
	return {
		...actual,
		getDb: () => {
			if (!mockDb) mockDb = testDb();
			return mockDb;
		}
	};
});

afterEach(() => {
	cleanupTestDbs();
	mockDb = undefined!;
});

describe('token bucket rate limiter', () => {
	it('limits bursts and refills over time', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 2, refillWindowMs: 1_000 };
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);
		expect(await limiter.check('client', policy, 0)).toEqual({
			allowed: false,
			retryAfterSeconds: 1
		});
		expect((await limiter.check('client', policy, 500)).allowed).toBe(true);
	});

	it('exhausts a single-token bucket and refills it', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		expect((await limiter.check('a', policy, 0)).allowed).toBe(true);
		expect((await limiter.check('a', policy, 0)).allowed).toBe(false);
		expect((await limiter.check('a', policy, 1_000)).allowed).toBe(true);
	});

	it('tracks buckets independently and refills after the window', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		expect((await limiter.check('a', policy, 0)).allowed).toBe(true);
		expect((await limiter.check('b', policy, 0)).allowed).toBe(true);

		expect((await limiter.check('a', policy, 999)).allowed).toBe(false);
		expect((await limiter.check('b', policy, 999)).allowed).toBe(false);

		expect((await limiter.check('a', policy, 1_001)).allowed).toBe(true);
		expect((await limiter.check('b', policy, 1_001)).allowed).toBe(true);
		expect((await limiter.check('a', policy, 1_001)).allowed).toBe(false);
	});

	it('prunes every stale bucket once the sweep interval has passed', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		for (const key of ['a', 'b', 'c', 'd'])
			expect((await limiter.check(key, policy, 0)).allowed).toBe(true);

		expect((await limiter.check('e', policy, 10 * 60_000 + 60_000)).allowed).toBe(true);
		expect((await limiter.check('f', policy, 10 * 60_000 + 60_000)).allowed).toBe(true);
		expect((await limiter.check('g', policy, 10 * 60_000 + 60_000)).allowed).toBe(true);
	});

	it('caps refill at capacity after a long idle', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 2, refillWindowMs: 1_000 };
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);

		expect((await limiter.check('client', policy, 10 * 60_000)).allowed).toBe(true);
		expect((await limiter.check('client', policy, 10 * 60_000)).allowed).toBe(true);
		expect(await limiter.check('client', policy, 10 * 60_000)).toEqual({
			allowed: false,
			retryAfterSeconds: 1
		});
	});

	it('reports multi-second retry windows proportional to missing tokens', async () => {
		const db = testDb();
		const limiter = new TokenBucketLimiter(db);
		const policy = { capacity: 2, refillWindowMs: 60_000 };
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);
		expect((await limiter.check('client', policy, 0)).allowed).toBe(true);

		const denied = await limiter.check('client', policy, 15_000);
		expect(denied).toEqual({ allowed: false, retryAfterSeconds: 15 });
	});
});

describe('admin api limiter', () => {
	it('throttles each address to a conservative budget, independently per address', async () => {
		for (let i = 0; i < 30; i++) {
			expect((await checkAdminApiLimit(() => '10.0.0.1')).allowed).toBe(true);
		}
		const blocked = await checkAdminApiLimit(() => '10.0.0.1');
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect((await checkAdminApiLimit(() => '10.0.0.2')).allowed).toBe(true);
	});

	it('tolerates clients without an address by sharing one fallback bucket', async () => {
		expect((await checkAdminApiLimit(() => 'unknown')).allowed).toBe(true);
		expect((await checkAdminApiLimit(() => 'unknown')).allowed).toBe(true);
	});
});
