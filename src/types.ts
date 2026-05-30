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
 *
 * `cost` (default `1`) lets callers charge a request as more than one
 * "unit." A bulk-import route might cost 10; an `OPTIONS` preflight might
 * cost 0.5 if you want to deprioritize it; a free-tier admin call can be
 * `cost: 0` to bypass entirely without showing up as a skip.
 */
export type Algorithm = {
	/** Per-call probe + commit. Returns the decision. */
	check: (
		store: Store,
		key: string,
		now: number,
		cost?: number,
	) => RateLimitDecision | Promise<RateLimitDecision>;
	/**
	 * Read-only inspection — current decision *as if* a cost-0 request just
	 * arrived. Useful for status pages and quota displays. Never mutates
	 * the store entry's value (the algorithm may still touch the entry's
	 * TTL — that's harmless).
	 */
	peek: (
		store: Store,
		key: string,
		now: number,
	) => RateLimitDecision | Promise<RateLimitDecision>;
	/** Clear a key's state (admin-style). Equivalent to `store.delete?.(key)`. */
	reset: (store: Store, key: string) => void | Promise<void>;
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
	/**
	 * Optional — operator-shaped point-in-time + cumulative store
	 * counters. `memoryStore` implements this; remote stores
	 * (Redis/Postgres) may or may not, depending on whether their
	 * backend exposes the equivalent (Redis can via INFO, PG via
	 * pg_stat_user_tables — both implementations may defer it).
	 *
	 * Added in 0.2.0.
	 */
	metrics?: () => StoreMetrics;
};

/**
 * Returned by {@link Store.metrics}. The `size` field is point-in-time;
 * the rest are cumulative since store creation. Added in 0.2.0.
 *
 * - `size` — current number of un-evicted entries.
 * - `updates` — total `update()` calls. Equal to the number of
 *   algorithm decisions made through this store.
 * - `evictions` — keys dropped by the LRU when `maxKeys` was reached.
 *   A non-zero, climbing value means the store is undersized for the
 *   tenant key cardinality and old keys are losing state mid-window.
 * - `deletes` — explicit `delete()` calls. Useful for noticing if a
 *   stuck-key cleanup script is firing more than expected.
 */
export type StoreMetrics = {
	size: number;
	updates: number;
	evictions: number;
	deletes: number;
};
