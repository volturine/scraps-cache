import { describe, expect, it } from 'vitest';
import { TokenBucketLimiter, checkAdminApiLimit } from './rateLimit';

describe('token bucket rate limiter', () => {
	it('limits bursts and refills over time', () => {
		let now = 0;
		const limiter = new TokenBucketLimiter(10, () => now);
		const policy = { capacity: 2, refillWindowMs: 1_000 };
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy)).toEqual({ allowed: false, retryAfterSeconds: 1 });
		now = 500;
		expect(limiter.check('client', policy).allowed).toBe(true);
	});

	it('refuses new keys instead of evicting active ones', () => {
		const limiter = new TokenBucketLimiter(2, () => 0);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		expect(limiter.check('a', policy).allowed).toBe(true);
		expect(limiter.check('b', policy).allowed).toBe(true);
		expect(limiter.check('c', policy).allowed).toBe(false);
		expect(limiter.check('a', policy).allowed).toBe(false);
	});

	it('admits new keys by evicting expired entries between throttled prunes', () => {
		let now = 0;
		const limiter = new TokenBucketLimiter(2, () => now);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		expect(limiter.check('a', policy).allowed).toBe(true);
		expect(limiter.check('b', policy).allowed).toBe(true);

		now = 9 * 60_000 + 59_999;
		expect(limiter.check('c', policy).allowed).toBe(false);

		now = 10 * 60_000 + 1;
		expect(limiter.check('d', policy).allowed).toBe(true);
		expect(limiter.check('e', policy).allowed).toBe(true);
		expect(limiter.check('f', policy).allowed).toBe(false);
	});

	it('prunes every stale bucket once the sweep interval has passed', () => {
		let now = 0;
		const limiter = new TokenBucketLimiter(4, () => now);
		const policy = { capacity: 1, refillWindowMs: 1_000 };
		for (const key of ['a', 'b', 'c', 'd']) expect(limiter.check(key, policy).allowed).toBe(true);

		now = 10 * 60_000 + 60_000;
		expect(limiter.check('e', policy).allowed).toBe(true);
		expect(limiter.check('f', policy).allowed).toBe(true);
		expect(limiter.check('g', policy).allowed).toBe(true);
	});

	it('caps refill at capacity after a long idle', () => {
		let now = 0;
		const limiter = new TokenBucketLimiter(10, () => now);
		const policy = { capacity: 2, refillWindowMs: 1_000 };
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy).allowed).toBe(true);

		now = 10 * 60_000;
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy)).toEqual({ allowed: false, retryAfterSeconds: 1 });
	});

	it('reports multi-second retry windows proportional to missing tokens', () => {
		let now = 0;
		const limiter = new TokenBucketLimiter(10, () => now);
		const policy = { capacity: 2, refillWindowMs: 60_000 };
		expect(limiter.check('client', policy).allowed).toBe(true);
		expect(limiter.check('client', policy).allowed).toBe(true);

		now = 15_000;
		const denied = limiter.check('client', policy);
		expect(denied).toEqual({ allowed: false, retryAfterSeconds: 15 });
	});
});

describe('admin api limiter', () => {
	it('throttles each address to a conservative budget, independently per address', () => {
		for (let i = 0; i < 30; i++) {
			expect(checkAdminApiLimit(() => '10.0.0.1').allowed).toBe(true);
		}
		const blocked = checkAdminApiLimit(() => '10.0.0.1');
		expect(blocked.allowed).toBe(false);
		if (!blocked.allowed) expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		expect(checkAdminApiLimit(() => '10.0.0.2').allowed).toBe(true);
	});

	it('tolerates clients without an address by sharing one fallback bucket', () => {
		expect(checkAdminApiLimit(() => 'unknown').allowed).toBe(true);
		expect(checkAdminApiLimit(() => 'unknown').allowed).toBe(true);
	});
});
