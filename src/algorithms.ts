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

	type State = { tat: string };

	const settleGcra = (storedTat: bigint, nowNs: bigint, allowed: boolean): RateLimitDecision => {
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

	const check = (store: Store, key: string, now: number, cost: number = 1) => {
		if (cost < 0) throw new Error('gcra.check: cost must be >= 0');
		const nowNs = BigInt(now) * ONE_MS_NS;
		let allowed = false;
		const increment = BigInt(Math.round(cost * 1_000_000)) * emissionInterval / ONE_MS_NS;
		const ret = store.update<State>(key, keyTtlMs, (prev) => {
			const lastTat = prev !== null ? BigInt(prev.tat) : 0n;
			// Conform check is against the OLD TAT — independent of cost. If you
			// would have been allowed even one emission, your cost-N goes through
			// and overdraws your future capacity by `(cost - 1) * T`. This matches
			// the natural "we let you over the limit, you wait it off" semantic.
			if (cost === 0) {
				allowed = true;
				return { tat: lastTat.toString() };
			}
			allowed = lastTat - tolerance <= nowNs;
			if (allowed) {
				const projectedTat = (lastTat > nowNs ? lastTat : nowNs) + increment;
				return { tat: projectedTat.toString() };
			}
			return { tat: lastTat.toString() };
		});

		const settle = (state: State) => settleGcra(BigInt(state.tat), nowNs, allowed);
		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const peek = (store: Store, key: string, now: number) => {
		const nowNs = BigInt(now) * ONE_MS_NS;
		const ret = store.update<State>(key, keyTtlMs, (prev) =>
			prev ?? { tat: '0' });
		const settle = (state: State) => {
			const storedTat = BigInt(state.tat);
			const allowedNow = storedTat - tolerance <= nowNs;
			return settleGcra(storedTat, nowNs, allowedNow);
		};
		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const reset = (store: Store, key: string) => {
		if (store.delete) {
			const result = store.delete(key);
			if (result instanceof Promise) return result;
		}
	};

	return { check, keyTtlMs, limit, peek, policy, reset };
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

	type TbState = { tokens: number; lastRefillAt: number };

	const settleTb = (state: TbState, allowed: boolean): RateLimitDecision => {
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

	const check = (store: Store, key: string, now: number, cost: number = 1) => {
		if (cost < 0) throw new Error('tokenBucket.check: cost must be >= 0');
		let allowed = false;
		const ret = store.update<TbState>(key, keyTtlMs, (prev) => {
			const start = prev ?? { lastRefillAt: now, tokens: capacity };
			const elapsedMs = Math.max(0, now - start.lastRefillAt);
			const refilled = Math.min(capacity, start.tokens + (elapsedMs / 1000) * refillPerSecond);
			if (cost === 0) {
				allowed = true;
				return { lastRefillAt: now, tokens: refilled };
			}
			if (refilled >= cost) {
				allowed = true;
				return { lastRefillAt: now, tokens: refilled - cost };
			}
			allowed = false;
			return { lastRefillAt: now, tokens: refilled };
		});

		const settle = (state: TbState) => settleTb(state, allowed);
		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const peek = (store: Store, key: string, now: number) => {
		const ret = store.update<TbState>(key, keyTtlMs, (prev) =>
			prev ?? { lastRefillAt: now, tokens: capacity });
		const settle = (state: TbState) => {
			const elapsedMs = Math.max(0, now - state.lastRefillAt);
			const refilled = Math.min(capacity, state.tokens + (elapsedMs / 1000) * refillPerSecond);
			const projected = { ...state, tokens: refilled };
			return settleTb(projected, refilled >= 1);
		};
		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const reset = (store: Store, key: string) => {
		if (store.delete) {
			const result = store.delete(key);
			if (result instanceof Promise) return result;
		}
	};

	return { check, keyTtlMs, limit: capacity, peek, policy, reset };
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

	type SwState = {
		currentCount: number;
		currentStartMs: number;
		prevCount: number;
	};

	const rollWindow = (prev: SwState | null, now: number): SwState => {
		const start = prev ?? { currentCount: 0, currentStartMs: now, prevCount: 0 };
		let { currentCount, currentStartMs, prevCount } = start;
		const elapsed = now - currentStartMs;
		if (elapsed >= 2 * periodMs) {
			prevCount = 0;
			currentCount = 0;
			currentStartMs = now;
		} else if (elapsed >= periodMs) {
			prevCount = currentCount;
			currentCount = 0;
			currentStartMs += periodMs;
		}
		return { currentCount, currentStartMs, prevCount };
	};

	const estimateAt = (state: SwState, now: number): number => {
		const elapsedInCurrent = now - state.currentStartMs;
		const weight = 1 - elapsedInCurrent / periodMs;
		return state.currentCount + state.prevCount * Math.max(0, weight);
	};

	const check = (store: Store, key: string, now: number, cost: number = 1) => {
		if (cost < 0) throw new Error('slidingWindow.check: cost must be >= 0');
		let estimate = 0;
		let allowed = false;
		const ret = store.update<SwState>(key, keyTtlMs, (prev) => {
			const rolled = rollWindow(prev, now);
			estimate = estimateAt(rolled, now);
			if (cost === 0) {
				allowed = true;
				return rolled;
			}
			allowed = estimate + cost <= requestsPerPeriod;
			if (allowed) rolled.currentCount += cost;
			return rolled;
		});

		const settle = (state: SwState): RateLimitDecision => {
			const remaining = Math.max(0, Math.floor(requestsPerPeriod - estimate - (allowed ? cost : 0)));
			const elapsedInCurrent = now - state.currentStartMs;
			const resetSec = Math.ceil(Math.max(0, periodMs - elapsedInCurrent) / 1000);
			const retryAfterSec = allowed ? 0 : Math.max(1, resetSec);
			return { allowed, limit: requestsPerPeriod, policy, remaining, resetSec, retryAfterSec };
		};

		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const peek = (store: Store, key: string, now: number) => {
		const ret = store.update<SwState>(key, keyTtlMs, (prev) => rollWindow(prev, now));
		const settle = (state: SwState) => {
			const estimate = estimateAt(state, now);
			const remaining = Math.max(0, Math.floor(requestsPerPeriod - estimate));
			const elapsedInCurrent = now - state.currentStartMs;
			const resetSec = Math.ceil(Math.max(0, periodMs - elapsedInCurrent) / 1000);
			return {
				allowed: estimate < requestsPerPeriod,
				limit: requestsPerPeriod,
				policy,
				remaining,
				resetSec,
				retryAfterSec: 0,
			};
		};
		if (ret instanceof Promise) return ret.then(settle);
		return settle(ret);
	};

	const reset = (store: Store, key: string) => {
		if (store.delete) {
			const result = store.delete(key);
			if (result instanceof Promise) return result;
		}
	};

	return { check, keyTtlMs, limit, peek, policy, reset };
};
