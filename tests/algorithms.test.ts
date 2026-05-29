import { describe, expect, test } from 'bun:test';
import {
	gcra,
	memoryStore,
	slidingWindow,
	tokenBucket,
	type Algorithm,
} from '../src/core';

const synced = (algo: Algorithm, store = memoryStore(), key = 'k') =>
	(now: number) => {
		const ret = algo.check(store, key, now);
		if (ret instanceof Promise) throw new Error('expected sync result');
		return ret;
	};

describe('gcra', () => {
	test('allows up to burst+1 in a tight cluster, then throttles', () => {
		// 10 requests / 1000 ms with burst of 5 = sustained 1 req per 100ms, 6 burstable.
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		const check = synced(algo);

		const now = 1_000_000;
		// First 6 should pass (burst + 1 emission slot).
		for (let i = 0; i < 6; i++) {
			expect(check(now).allowed).toBe(true);
		}
		expect(check(now).allowed).toBe(false);
	});

	test('throttled requests get a retryAfterSec hint', () => {
		const algo = gcra({ burst: 0, periodMs: 1000, requestsPerPeriod: 10 });
		const check = synced(algo);

		expect(check(0).allowed).toBe(true);
		const refused = check(0);
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
	});

	test('refills smoothly as time passes', () => {
		const algo = gcra({ burst: 0, periodMs: 1000, requestsPerPeriod: 10 });
		const check = synced(algo);

		// Burn the first slot.
		expect(check(0).allowed).toBe(true);
		expect(check(0).allowed).toBe(false);
		// 100ms = exactly one emission interval for 10/sec.
		expect(check(100).allowed).toBe(true);
		expect(check(100).allowed).toBe(false);
		expect(check(200).allowed).toBe(true);
	});

	test('remaining decreases as burst is consumed', () => {
		const algo = gcra({ burst: 4, periodMs: 1000, requestsPerPeriod: 10 });
		const check = synced(algo);
		const first = check(0);
		expect(first.allowed).toBe(true);
		expect(first.remaining).toBe(4);
		const second = check(0);
		expect(second.remaining).toBe(3);
	});

	test('limit + policy reflect the config', () => {
		const algo = gcra({ burst: 5, periodMs: 60_000, requestsPerPeriod: 100 });
		// `limit` is the immediate burst ceiling (burst + 1 back-to-back).
		expect(algo.limit).toBe(6);
		// `policy` carries the sustained rate and burst separately.
		expect(algo.policy).toContain('100;w=60');
		expect(algo.policy).toContain('burst=5');
	});

	test('throws on bad params', () => {
		expect(() => gcra({ periodMs: 1000, requestsPerPeriod: 0 })).toThrow();
		expect(() => gcra({ periodMs: 0, requestsPerPeriod: 10 })).toThrow();
		expect(() => gcra({ burst: -1, periodMs: 1000, requestsPerPeriod: 10 })).toThrow();
	});

	test('long-running TAT does not drift (BigInt nanosecond TAT)', () => {
		const algo = gcra({ burst: 0, periodMs: 1000, requestsPerPeriod: 100 });
		const check = synced(algo);
		// Simulate 10_000 evenly-spaced requests.
		for (let i = 0; i < 10_000; i++) {
			expect(check(i * 10).allowed).toBe(true);
		}
		// At the right pace this should be sustainable forever.
		expect(check(100_000).allowed).toBe(true);
	});
});

describe('tokenBucket', () => {
	test('allows up to capacity then throttles', () => {
		const algo = tokenBucket({ capacity: 3, refillPerSecond: 1 });
		const check = synced(algo);
		expect(check(0).allowed).toBe(true);
		expect(check(0).allowed).toBe(true);
		expect(check(0).allowed).toBe(true);
		expect(check(0).allowed).toBe(false);
	});

	test('refills at the configured rate', () => {
		const algo = tokenBucket({ capacity: 3, refillPerSecond: 1 });
		const check = synced(algo);
		// Drain.
		check(0); check(0); check(0);
		expect(check(0).allowed).toBe(false);
		// 1s = 1 token refilled.
		expect(check(1000).allowed).toBe(true);
		expect(check(1000).allowed).toBe(false);
	});

	test('does not overflow capacity', () => {
		const algo = tokenBucket({ capacity: 3, refillPerSecond: 1 });
		const check = synced(algo);
		check(0); check(0); check(0);
		// 10s idle → bucket back to 3 (not 13).
		expect(check(10_000).allowed).toBe(true);
		expect(check(10_000).allowed).toBe(true);
		expect(check(10_000).allowed).toBe(true);
		expect(check(10_000).allowed).toBe(false);
	});

	test('refused requests report retryAfterSec', () => {
		const algo = tokenBucket({ capacity: 1, refillPerSecond: 0.5 });
		const check = synced(algo);
		check(0);
		const refused = check(0);
		expect(refused.allowed).toBe(false);
		expect(refused.retryAfterSec).toBeGreaterThanOrEqual(1);
	});
});

describe('slidingWindow', () => {
	test('allows up to limit per window', () => {
		const algo = slidingWindow({ periodMs: 1000, requestsPerPeriod: 5 });
		const check = synced(algo);
		for (let i = 0; i < 5; i++) {
			expect(check(0).allowed).toBe(true);
		}
		expect(check(0).allowed).toBe(false);
	});

	test('window rotates after periodMs', () => {
		const algo = slidingWindow({ periodMs: 1000, requestsPerPeriod: 3 });
		const check = synced(algo);
		// 3 in the current window.
		check(0); check(0); check(0);
		expect(check(0).allowed).toBe(false);
		// 1 full period later → previous window weight goes to 0; new fresh allotment.
		expect(check(2001).allowed).toBe(true);
	});

	test('approximation: rolling estimate combines prev + current windows', () => {
		const algo = slidingWindow({ periodMs: 1000, requestsPerPeriod: 4 });
		const check = synced(algo);
		// Fill 4 in the previous window.
		check(0); check(0); check(0); check(0);
		// 500ms into the next window: prev counts 4 * 0.5 = 2.
		// We've used 0 in the current window, so estimate = 2 + 0 = 2 < 4: allow.
		expect(check(1500).allowed).toBe(true);
		expect(check(1500).allowed).toBe(true);
		// Now currentCount=2, estimate = 2 + 4*0.5 = 4: refuse.
		expect(check(1500).allowed).toBe(false);
	});
});
