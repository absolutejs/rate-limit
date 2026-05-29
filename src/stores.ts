/**
 * Bundled `Store` implementations. v0.0.1 ships one: `memoryStore`, an
 * LRU + lazy-TTL Map. Redis / Postgres adapters ship as siblings.
 *
 * Why lazy TTL: the rate-limit hot path is one Map lookup per request. A
 * background sweeper means an extra timer per process plus contention on
 * Map iteration. Lazy TTL means TTL is checked only when a key is touched —
 * stale-but-not-evicted entries cost no CPU until they would have been
 * looked up anyway, at which point we discard them in O(1).
 */

import type { Store } from './types';

export type MemoryStoreOptions = {
	/**
	 * Hard cap on entries before LRU eviction. The least-recently-touched
	 * key is dropped to make room. Default `100_000`.
	 */
	maxKeys?: number;
	/**
	 * Default TTL for entries when the algorithm doesn't specify one
	 * (algorithms always specify one in practice; this is the fallback for
	 * direct callers). Default 1 hour.
	 */
	defaultTtlMs?: number;
	/** Override `Date.now` for tests. */
	clock?: () => number;
};

type Entry<T> = {
	value: T;
	expiresAt: number;
};

export const memoryStore = (options: MemoryStoreOptions = {}): Store => {
	const maxKeys = options.maxKeys ?? 100_000;
	const defaultTtl = options.defaultTtlMs ?? 3_600_000;
	const clock = options.clock ?? Date.now;
	// JS Map preserves insertion order — re-set on touch gets LRU ordering for free.
	const map = new Map<string, Entry<unknown>>();

	const evictIfNeeded = () => {
		while (map.size > maxKeys) {
			const oldestKey = map.keys().next().value;
			if (oldestKey === undefined) break;
			map.delete(oldestKey);
		}
	};

	return {
		clear: () => { map.clear(); },
		delete: (key) => { map.delete(key); },
		update: <T,>(key: string, ttlMs: number, fn: (prev: T | null) => T): T => {
			const now = clock();
			const ttl = ttlMs > 0 ? ttlMs : defaultTtl;
			const existing = map.get(key) as Entry<T> | undefined;
			const prev: T | null = existing !== undefined && existing.expiresAt > now
				? existing.value
				: null;
			const next = fn(prev);
			// Delete + re-set to move to the back of the insertion-order list (LRU "touch").
			map.delete(key);
			map.set(key, { expiresAt: now + ttl, value: next });
			evictIfNeeded();
			return next;
		},
	};
};
