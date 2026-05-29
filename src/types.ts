/**
 * Shared types for `@absolutejs/rate-limit`.
 *
 * The library separates three concerns:
 *
 *   1. Algorithms — pure stateless functions of `(prevState, now, params)`.
 *      Three are bundled: GCRA (default), token bucket, sliding window
 *      counter.
 *   2. Stores — atomic read-modify-write per key, with TTL. One bundled:
 *      `memoryStore` (LRU + lazy TTL eviction). Redis / Postgres ship as
 *      siblings later.
 *   3. Adapters — `rateLimit()` Elysia plugin (in `./elysia`) is the main
 *      consumer. The algorithms + store are also exported for direct use
 *      outside HTTP.
 */

export type RateLimitDecision = {
	/** Was the request allowed? */
	allowed: boolean;
	/** Numeric request cap implied by the algorithm parameters. */
	limit: number;
	/** Best-effort remaining allowance under the cap. >= 0. */
	remaining: number;
	/** Seconds until the caller may retry, when `allowed === false`. `0` when allowed. */
	retryAfterSec: number;
	/** Seconds until the bucket / window resets to full. */
	resetSec: number;
	/**
	 * Policy descriptor for the IETF `RateLimit-Policy` header, e.g.
	 * `"100;w=60"` (100 requests per 60-second window). Same string returned
	 * on every call for a given Algorithm.
	 */
	policy: string;
};

/**
 * Algorithm — given the current per-key state from the store + `now`, compute
 * the next state and the decision. The store's `update` function provides
 * the atomic CAS semantics; the algorithm itself is pure.
 *
 * Returns may be sync (in-memory store) or async (Redis/Postgres). The
 * library threads sync/async through the type system so the hot path stays
 * sync when the store does.
 */
export type Algorithm = {
	/** Per-call probe + commit. Returns the decision. */
	check: (store: Store, key: string, now: number) => RateLimitDecision | Promise<RateLimitDecision>;
	/** TTL the store should retain a key's state. Algorithm-dependent. */
	keyTtlMs: number;
	/** Policy descriptor — surfaced on `RateLimitDecision.policy`. */
	policy: string;
	/** Limit value — surfaced on `RateLimitDecision.limit`. */
	limit: number;
};

/**
 * Store interface — atomic read-modify-write per key with a TTL hint. The
 * store guarantees only that two concurrent `update` calls for the same
 * key are linearized (the second sees the first's result). Stale entries
 * past `ttlMs` are eligible for eviction; the store does not need to evict
 * them eagerly.
 */
export type Store = {
	/**
	 * Atomically read the prior value, pass to `fn`, store `fn`'s return.
	 * Returns the new value. The store sets the entry's TTL to `ttlMs`.
	 */
	update: <T>(key: string, ttlMs: number, fn: (prev: T | null) => T) => T | Promise<T>;
	/** Drop a single key. Useful for tests. */
	delete?: (key: string) => void | Promise<void>;
	/** Drop all keys. Useful for tests. */
	clear?: () => void | Promise<void>;
};
