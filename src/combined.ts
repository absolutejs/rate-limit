/**
 * `combined({ algorithms })` — compose multiple `Algorithm`s into one that
 * passes only when every underlying algorithm passes. Use this to stack
 * limits (e.g. "100/minute per IP AND 10000/day per user-id") in a single
 * `rateLimit()` plugin.
 *
 * The composed algorithm carries the LOWEST `limit` of its components for
 * the `RateLimit` header (the tightest gate is the one a client should be
 * watching), and concatenates each component's `policy` string with `, `
 * separating entries — that's the IETF format for multiple policies on one
 * header.
 *
 * Stores: each component algorithm uses the same `Store` instance; the
 * library auto-namespaces with `${index}|${key}` to prevent collisions.
 */

import type { Algorithm, RateLimitDecision, Store } from './types';

export type CombinedOptions = {
	algorithms: Algorithm[];
};

const NEUTRAL_DECISION = (): RateLimitDecision => ({
	allowed: true,
	limit: Infinity,
	policy: '',
	remaining: Infinity,
	resetSec: 0,
	retryAfterSec: 0,
});

const mergeDecisions = (decisions: RateLimitDecision[]): RateLimitDecision => {
	const allowed = decisions.every((decision) => decision.allowed);
	let limit = Infinity;
	let remaining = Infinity;
	let resetSec = 0;
	let retryAfterSec = 0;
	for (const decision of decisions) {
		if (decision.limit < limit) limit = decision.limit;
		if (decision.remaining < remaining) remaining = decision.remaining;
		if (decision.resetSec > resetSec) resetSec = decision.resetSec;
		if (!decision.allowed && decision.retryAfterSec > retryAfterSec) {
			retryAfterSec = decision.retryAfterSec;
		}
	}
	const policy = decisions.map((decision) => decision.policy).filter(Boolean).join(', ');
	return {
		allowed,
		limit: Number.isFinite(limit) ? limit : 0,
		policy,
		remaining: Number.isFinite(remaining) ? remaining : 0,
		resetSec,
		retryAfterSec: allowed ? 0 : retryAfterSec,
	};
};

export const combined = (options: CombinedOptions): Algorithm => {
	const algorithms = options.algorithms;
	if (algorithms.length === 0) throw new Error('combined: at least one algorithm required');

	const limit = algorithms.reduce((acc, algorithm) => Math.min(acc, algorithm.limit), Infinity);
	const policy = algorithms.map((algorithm) => algorithm.policy).filter(Boolean).join(', ');
	const keyTtlMs = algorithms.reduce((acc, algorithm) => Math.max(acc, algorithm.keyTtlMs), 0);

	const nsKey = (i: number, key: string) => `${i}|${key}`;

	const check = (store: Store, key: string, now: number, cost: number = 1) => {
		const decisions: Array<RateLimitDecision | Promise<RateLimitDecision>> = [];
		for (let i = 0; i < algorithms.length; i++) {
			decisions.push(algorithms[i]!.check(store, nsKey(i, key), now, cost));
		}
		const hasPromise = decisions.some((decision) => decision instanceof Promise);
		if (hasPromise) {
			return Promise.all(decisions).then(mergeDecisions);
		}
		return mergeDecisions(decisions as RateLimitDecision[]);
	};

	const peek = (store: Store, key: string, now: number) => {
		const decisions: Array<RateLimitDecision | Promise<RateLimitDecision>> = [];
		for (let i = 0; i < algorithms.length; i++) {
			decisions.push(algorithms[i]!.peek(store, nsKey(i, key), now));
		}
		const hasPromise = decisions.some((decision) => decision instanceof Promise);
		if (hasPromise) {
			return Promise.all(decisions).then(mergeDecisions);
		}
		return mergeDecisions(decisions as RateLimitDecision[]);
	};

	const reset = (store: Store, key: string) => {
		const promises: Promise<void>[] = [];
		for (let i = 0; i < algorithms.length; i++) {
			const result = algorithms[i]!.reset(store, nsKey(i, key));
			if (result instanceof Promise) promises.push(result);
		}
		if (promises.length > 0) return Promise.all(promises).then(() => {});
	};

	return { check, keyTtlMs, limit: Number.isFinite(limit) ? limit : 0, peek, policy, reset };
};

void NEUTRAL_DECISION;
