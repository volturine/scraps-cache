import { recordRateLimit } from '$lib/server/metrics';
import { getDb, type Db } from '$lib/server/db';

export type RateLimitPolicy = {
	capacity: number;
	refillWindowMs: number;
};

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export const RATE_BUCKET_STALE_MS = 10 * 60_000;

const CHECK_SQL = `
	INSERT INTO rate_buckets (bucket_key, tokens, updated_at, last_seen_at, last_allowed)
	VALUES (?1, ?2 - 1, ?3, ?3, 1)
	ON CONFLICT(bucket_key) DO UPDATE SET
		tokens = CASE
			WHEN min(?2, rate_buckets.tokens + (?3 - rate_buckets.updated_at) * ?4) >= 1
			THEN min(?2, rate_buckets.tokens + (?3 - rate_buckets.updated_at) * ?4) - 1
			ELSE min(?2, rate_buckets.tokens + (?3 - rate_buckets.updated_at) * ?4)
		END,
		last_allowed = CASE
			WHEN min(?2, rate_buckets.tokens + (?3 - rate_buckets.updated_at) * ?4) >= 1 THEN 1
			ELSE 0
		END,
		updated_at = ?3,
		last_seen_at = ?3
	RETURNING tokens AS tokens, last_allowed AS allowed
`;

/** Durable token bucket: one atomic upsert per check so every server isolate
 * shares the same allowance for a key. */
export class TokenBucketLimiter {
	constructor(private readonly db: Db) {}

	async check(key: string, policy: RateLimitPolicy, now = Date.now()): Promise<RateLimitResult> {
		const refillPerMs = policy.capacity / policy.refillWindowMs;
		try {
			await this.db.ready;
			const result = await this.db.ops.execute({
				sql: CHECK_SQL,
				args: [key, policy.capacity, now, refillPerMs]
			});
			const bucket = result.rows[0] as unknown as { tokens: number; allowed: number };
			if (bucket.allowed === 1) return { allowed: true };
			const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
			return { allowed: false, retryAfterSeconds };
		} catch {
			return { allowed: false, retryAfterSeconds: 1 };
		}
	}
}

let publicLimiter: TokenBucketLimiter | undefined;

export function getPublicApiLimiter(): TokenBucketLimiter {
	publicLimiter ??= new TokenBucketLimiter(getDb());
	return publicLimiter;
}

export async function checkAdminApiLimit(
	getClientAddress: () => string,
	now = Date.now()
): Promise<RateLimitResult> {
	const limiter = new TokenBucketLimiter(getDb());
	return limiter.check(
		`admin:${clientAddress(getClientAddress)}`,
		{
			capacity: 30,
			refillWindowMs: 60_000
		},
		now
	);
}

export async function pruneRateBuckets(db: Db, now = Date.now()): Promise<void> {
	await db.ready;
	await db.ops.execute({
		sql: 'DELETE FROM rate_buckets WHERE last_seen_at <= ?',
		args: [now - RATE_BUCKET_STALE_MS]
	});
}

export function clientAddress(getClientAddress: () => string): string {
	try {
		return getClientAddress();
	} catch {
		return 'unknown';
	}
}

export function rateLimitResponse(result: Exclude<RateLimitResult, { allowed: true }>): Response {
	recordRateLimit();
	return Response.json(
		{ error: 'Too many requests' },
		{ status: 429, headers: { 'retry-after': String(result.retryAfterSeconds) } }
	);
}

let activeSyncRequests = 0;

export function enterSyncRequest(maxConcurrent = 8): (() => void) | null {
	if (activeSyncRequests >= maxConcurrent) return null;
	activeSyncRequests += 1;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		activeSyncRequests = Math.max(0, activeSyncRequests - 1);
	};
}
