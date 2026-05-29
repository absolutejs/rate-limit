/**
 * `@absolutejs/rate-limit` — first-class 2026 rate-limit for Bun + Elysia.
 *
 * Default export: everything. Subpath exports:
 *   - `./elysia` — just the Elysia plugin (re-exported here for convenience).
 *   - `./core` — algorithms + store + helpers, no Elysia dependency.
 */

export * from './core';
export {
	rateLimit,
	type KeyResolver,
	type LimitInfo,
	type RateLimitContext,
	type RateLimitOptions,
} from './elysia';
