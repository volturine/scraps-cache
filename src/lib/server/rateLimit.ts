import { recordRateLimit } from '$lib/server/metrics';

export type RateLimitPolicy = {
	capacity: number;
	refillWindowMs: number;
};

export type RateLimitResult =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number };

type Bucket = {
	tokens: number;
	updatedAt: number;
	lastSeen: number;
};

export class TokenBucketLimiter {
	private readonly buckets = new Map<string, Bucket>();

	constructor(
		private readonly maxEntries = 20_000,
		private readonly now: () => number = Date.now
	) {}

	check(key: string, policy: RateLimitPolicy): RateLimitResult {
		const now = this.now();
		const refillPerMs = policy.capacity / policy.refillWindowMs;
		const existing = this.buckets.get(key);
		const bucket = existing ?? { tokens: policy.capacity, updatedAt: now, lastSeen: now };
		bucket.tokens = Math.min(
			policy.capacity,
			bucket.tokens + Math.max(0, now - bucket.updatedAt) * refillPerMs
		);
		bucket.updatedAt = now;
		bucket.lastSeen = now;
		if (!existing) this.buckets.set(key, bucket);
		if (bucket.tokens >= 1) {
			bucket.tokens -= 1;
			this.prune();
			return { allowed: true };
		}
		const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000));
		this.prune();
		return { allowed: false, retryAfterSeconds };
	}

	private prune(): void {
		if (this.buckets.size <= this.maxEntries) return;
		const oldest = [...this.buckets.entries()]
			.sort((left, right) => left[1].lastSeen - right[1].lastSeen)
			.slice(0, Math.max(1, this.buckets.size - this.maxEntries));
		for (const [key] of oldest) this.buckets.delete(key);
	}
}

export const publicApiLimiter = new TokenBucketLimiter();

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
