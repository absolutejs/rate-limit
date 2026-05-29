/**
 * Header formatting.
 *
 * Two header conventions exist in the wild:
 *
 *   1. **IETF draft-ietf-httpapi-ratelimit-headers** (the 2024+ standard).
 *      Combined `RateLimit` header carries `limit`, `remaining`, `reset`
 *      together; `RateLimit-Policy` describes the policy. This is the right
 *      modern default.
 *   2. **Legacy X-RateLimit-*** (popularized by GitHub circa 2014). Three
 *      separate headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
 *      `X-RateLimit-Reset`. Still widely understood; useful when the caller
 *      needs to support older clients.
 *
 * `Retry-After` (RFC 9110 §10.2.3) is sent on `429` responses regardless of
 * which set is selected — it's the only header HTTP clients (curl, fetch,
 * browsers) consistently honor.
 */

import type { RateLimitDecision } from './types';

export type HeaderMode = 'standard' | 'legacy' | 'both' | false;

export const formatHeaders = (
	decision: RateLimitDecision,
	mode: HeaderMode = 'standard',
): Record<string, string> => {
	const out: Record<string, string> = {};

	if (mode === false) {
		if (!decision.allowed && decision.retryAfterSec > 0) {
			out['Retry-After'] = String(decision.retryAfterSec);
		}
		return out;
	}

	if (mode === 'standard' || mode === 'both') {
		// IETF draft-09 combined RateLimit + RateLimit-Policy.
		out['RateLimit'] = `limit=${decision.limit}, remaining=${decision.remaining}, reset=${decision.resetSec}`;
		out['RateLimit-Policy'] = decision.policy;
	}
	if (mode === 'legacy' || mode === 'both') {
		out['X-RateLimit-Limit'] = String(decision.limit);
		out['X-RateLimit-Remaining'] = String(decision.remaining);
		out['X-RateLimit-Reset'] = String(decision.resetSec);
	}
	if (!decision.allowed && decision.retryAfterSec > 0) {
		out['Retry-After'] = String(decision.retryAfterSec);
	}
	return out;
};
