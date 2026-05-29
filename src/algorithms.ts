/**
 * Bundled rate-limit algorithms. All pure functions of `(prevState, now,
 * params)`; the store provides the atomic CAS.
 *
 *   - `gcra`           — Generic Cell Rate Algorithm (default).
 *                        Exact. O(1) memory per key (one BigInt: TAT).
 *                        No boundary effects. Used by Stripe.
 *   - `tokenBucket`    — Classic. Allows brief bursts at refill boundaries.
 *                        O(1) memory per key (two numbers).
 *   - `slidingWindow`  — Sliding-window counter (approximate). O(1) memory.
 *                        Useful when you want a "last N seconds" budget
 *                        that's easy to explain to a customer.
 */

import type { Algorithm, RateLimitDecision, Store } from './types';

// -----------------------------------------------------------------------------
// GCRA — Generic Cell Rate Algorithm
// -----------------------------------------------------------------------------

/**
 * Construct a GCRA limiter. State per key is one BigInt: TAT (Theoretical
 * Arrival Time) in nanoseconds.
 *
 *   T  = emission interval = `periodMs * 1_000_000n / requestsPerPeriod`
 *   τ  = tolerance         = `(burst + 1) * T  -  T  =  burst * T`
 *
 * For each request at time `now`:
 *
 *   nowNs       = BigInt(now * 1_000_000)
 *   newTat      = (lastTat > nowNs ? lastTat : nowNs) + T
 *   allowedIf   = newTat - τ <= nowNs
 *   retryAfter  = (newTat - τ - nowNs) / 1ms when not allowed
 *   remaining   = max(0, ⌊(τ - (newTat - nowNs)) / T⌋)
 *
 * Why BigInt nanoseconds: at millisecond-float precision, repeated TAT
 * accumulation over hours drifts. Nanosecond BigInt is exact to the period
 * lengths anyone configures.
 */
export type GcraOptions = {
	/** Sustained rate over `periodMs`. */
	requestsPerPeriod: number;
	periodMs: number;
	/**
	 * Number of additional requests allowed in a burst beyond the steady-state
	 * cap. `0` = pure throttling, no slack. Default `0`. (Token-bucket
	 * equivalent: capacity = requestsPerPeriod + burst, refillPerSecond =
	 * requestsPerPeriod / (periodMs / 1000).)
	 */
	burst?: number;
};

const ONE_MS_NS = 1_000_000n;
const ONE_SEC_NS = 1_000_000_000n;

export const gcra = (options: GcraOptions): Algorithm => {
	const requestsPerPeriod = options.requestsPerPeriod;
	const periodMs = options.periodMs;
	const burst = options.burst ?? 0;
	if (requestsPerPeriod <= 0) throw new Error('gcra: requestsPerPeriod must be > 0');
	if (periodMs <= 0) throw new Error('gcra: periodMs must be > 0');
	if (burst < 0) throw new Error('gcra: burst must be >= 0');

	const emissionInterval = (BigInt(periodMs) * ONE_MS_NS) / BigInt(requestsPerPeriod);
	const tolerance = BigInt(burst) * emissionInterval;
	// `limit` is the IMMEDIATE ceiling — how many back-to-back fit before throttling.
	// `policy` carries the sustained rate + burst separately for clients that want both.
	const limit = burst + 1;
	const policy = `${requestsPerPeriod};w=${Math.round(periodMs / 1000)}${burst > 0 ? `;burst=${burst}` : ''}`;
	// Keep a key's state for one tolerance window past sustained period to avoid stale TAT issues.
	const keyTtlMs = periodMs + Math.ceil(Number(tolerance / ONE_MS_NS));

	const check = (store: Store, key: string, now: number) => {
		const nowNs = BigInt(now) * ONE_MS_NS;
		type State = { tat: string };
		let allowed = false;
		const ret = store.update<State>(key, keyTtlMs, (prev) => {
			const lastTat = prev !== null ? BigInt(prev.tat) : 0n;
			// Conform test runs against the OLD TAT (the classic GCRA formulation —
			// "did this arrival come early enough to fit under the tolerance ceiling").
			allowed = lastTat - tolerance <= nowNs;
			if (allowed) {
				const newTat = (lastTat > nowNs ? lastTat : nowNs) + emissionInterval;
				return { tat: newTat.toString() };
			}
			return { tat: lastTat.toString() };
		});

		const settle = (state: State): RateLimitDecision => {
			const storedTat = BigInt(state.tat);
			const gap = storedTat > nowNs ? storedTat - nowNs : 0n;
			const used = Number(gap / emissionInterval);
			const remaining = Math.max(0, limit - used);
			let retryAfterSec = 0;
			if (!allowed) {
				const waitNs = gap - tolerance;
				retryAfterSec = waitNs > 0n
					? Math.max(1, Math.ceil(Number(waitNs) / 1_000_000_000))
					: 1;
			}
			let resetSec = 0;
			if (gap > 0n) resetSec = Math.ceil(Number(gap / ONE_SEC_NS));
			return { allowed, limit, policy, remaining, resetSec, retryAfterSec };
		};

		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	return { check, keyTtlMs, limit, policy };
};

// -----------------------------------------------------------------------------
// Token bucket
// -----------------------------------------------------------------------------

/**
 * Classic token bucket. State per key: `{ tokens, lastRefillAt }`.
 *
 * Pros: simple, allows bursts up to capacity.
 * Cons: float arithmetic on `tokens`; the burst behavior is exactly the
 * behavior some folks want and some don't — GCRA is preferred when you
 * want a hard ceiling with no burst slack.
 */
export type TokenBucketOptions = {
	capacity: number;
	refillPerSecond: number;
};

export const tokenBucket = (options: TokenBucketOptions): Algorithm => {
	const { capacity, refillPerSecond } = options;
	if (capacity <= 0) throw new Error('tokenBucket: capacity must be > 0');
	if (refillPerSecond < 0) throw new Error('tokenBucket: refillPerSecond must be >= 0');

	const policy = refillPerSecond > 0
		? `${capacity};w=${Math.round(capacity / refillPerSecond)}`
		: `${capacity};w=0`;
	const fullRefillMs = refillPerSecond > 0 ? Math.ceil((capacity / refillPerSecond) * 1000) : 3_600_000;
	const keyTtlMs = fullRefillMs + 5_000;

	const check = (store: Store, key: string, now: number) => {
		type State = { tokens: number; lastRefillAt: number };
		let allowed = false;
		const ret = store.update<State>(key, keyTtlMs, (prev) => {
			const start = prev ?? { lastRefillAt: now, tokens: capacity };
			const elapsedMs = Math.max(0, now - start.lastRefillAt);
			const refilled = Math.min(capacity, start.tokens + (elapsedMs / 1000) * refillPerSecond);
			if (refilled >= 1) {
				allowed = true;
				return { lastRefillAt: now, tokens: refilled - 1 };
			}
			allowed = false;
			return { lastRefillAt: now, tokens: refilled };
		});

		const settle = (state: State): RateLimitDecision => {
			const remaining = Math.max(0, Math.floor(state.tokens));
			const retryAfterSec = allowed
				? 0
				: refillPerSecond > 0
					? Math.max(1, Math.ceil((1 - state.tokens) / refillPerSecond))
					: 0;
			const resetSec = refillPerSecond > 0
				? Math.ceil((capacity - state.tokens) / refillPerSecond)
				: 0;
			return { allowed, limit: capacity, policy, remaining, resetSec, retryAfterSec };
		};

		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	return { check, keyTtlMs, limit: capacity, policy };
};

// -----------------------------------------------------------------------------
// Sliding window counter (approximation)
// -----------------------------------------------------------------------------

/**
 * Approximate sliding-window counter. State per key:
 * `{ currentCount, currentStartMs, prevCount }`. On each call, the
 * estimated current rolling count is:
 *
 *   estimate = currentCount + prevCount * (1 - elapsedInCurrent / windowMs)
 *
 * Allowed iff `estimate < limit`. Pros: O(1) memory, intuitive to explain.
 * Cons: under heavy clustering at the boundary the approximation can
 * under-count by up to one slot — for hard guarantees, use GCRA.
 */
export type SlidingWindowOptions = {
	requestsPerPeriod: number;
	periodMs: number;
};

export const slidingWindow = (options: SlidingWindowOptions): Algorithm => {
	const { requestsPerPeriod, periodMs } = options;
	if (requestsPerPeriod <= 0) throw new Error('slidingWindow: requestsPerPeriod must be > 0');
	if (periodMs <= 0) throw new Error('slidingWindow: periodMs must be > 0');

	const policy = `${requestsPerPeriod};w=${Math.round(periodMs / 1000)}`;
	const keyTtlMs = periodMs * 2 + 1000;
	const limit = requestsPerPeriod;

	const check = (store: Store, key: string, now: number) => {
		type State = {
			currentCount: number;
			currentStartMs: number;
			prevCount: number;
		};

		let estimate = 0;
		const ret = store.update<State>(key, keyTtlMs, (prev) => {
			const start = prev ?? {
				currentCount: 0,
				currentStartMs: now,
				prevCount: 0,
			};
			let { currentCount, currentStartMs, prevCount } = start;
			const elapsed = now - currentStartMs;
			if (elapsed >= 2 * periodMs) {
				// Both windows are stale.
				prevCount = 0;
				currentCount = 0;
				currentStartMs = now;
			} else if (elapsed >= periodMs) {
				// Roll the window: previous becomes the just-elapsed window.
				prevCount = currentCount;
				currentCount = 0;
				currentStartMs += periodMs;
			}
			const elapsedInCurrent = now - currentStartMs;
			const weight = 1 - elapsedInCurrent / periodMs;
			estimate = currentCount + prevCount * Math.max(0, weight);
			const allowed = estimate < requestsPerPeriod;
			if (allowed) currentCount += 1;
			return { currentCount, currentStartMs, prevCount };
		});

		const settle = (state: State): RateLimitDecision => {
			const allowed = estimate < requestsPerPeriod;
			const remaining = Math.max(0, Math.floor(requestsPerPeriod - estimate - (allowed ? 1 : 0)));
			const elapsedInCurrent = now - state.currentStartMs;
			const resetSec = Math.ceil(Math.max(0, periodMs - elapsedInCurrent) / 1000);
			const retryAfterSec = allowed ? 0 : Math.max(1, resetSec);
			return {
				allowed,
				limit: requestsPerPeriod,
				policy,
				remaining,
				resetSec,
				retryAfterSec,
			};
		};

		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	return { check, keyTtlMs, limit, policy };
};
