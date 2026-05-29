/**
 * Elysia plugin entry point. Marked as a peer dep so non-Elysia callers can
 * import `@absolutejs/rate-limit/core` without pulling Elysia.
 */

import { Elysia } from 'elysia';
import type { Algorithm, RateLimitDecision, Store } from './types';
import { memoryStore } from './stores';
import { extractIp } from './ip';
import { formatHeaders, type HeaderMode } from './headers';

export type RateLimitContext = {
	request: Request;
	server?: { requestIP?: (request: Request) => { address: string } | null } | null;
	headers?: Record<string, string | undefined>;
};

export type KeyResolver = 'ip' | 'authorization' | ((ctx: RateLimitContext) => string | null);

export type LimitInfo = {
	decision: RateLimitDecision;
	key: string;
};

export type RateLimitOptions = {
	algorithm: Algorithm;
	store?: Store;
	/**
	 * How to derive the per-request rate-limit key. `'ip'` (default) uses
	 * `extractIp` with the `trustedProxies` / `ipv6Prefix` options below.
	 * `'authorization'` uses the `Authorization` header (good for an
	 * authenticated API where IPs aren't stable).  Or pass a function for
	 * any custom shape.
	 */
	key?: KeyResolver;
	/**
	 * Number of trusted proxies in front of the app for IP extraction. Only
	 * relevant when `key === 'ip'`. Default `0` (don't trust XFF).
	 */
	trustedProxies?: number;
	/**
	 * IPv6 prefix length to group by. Default `64`. Only relevant when
	 * `key === 'ip'`.
	 */
	ipv6Prefix?: number;
	/**
	 * Synchronous predicate to bypass the limit entirely (e.g. for admin
	 * tokens). Return `true` to skip. Sync — async key resolution belongs
	 * in `key`.
	 */
	skip?: (ctx: RateLimitContext) => boolean;
	/**
	 * Header mode. Default `'standard'` (IETF draft-09 `RateLimit-*`).
	 * Use `'legacy'` for the older `X-RateLimit-*` set; `'both'` to emit
	 * both; `false` to suppress all rate-limit headers (Retry-After still
	 * sent on 429s).
	 */
	headers?: HeaderMode;
	/**
	 * Override the 429 response. Default: `429 Too Many Requests` body
	 * with `Retry-After` + rate-limit headers attached. Return a `Response`
	 * to be sent verbatim, or `false` to fall back to the default.
	 */
	onLimit?: (ctx: RateLimitContext, info: LimitInfo) => Response | false | Promise<Response | false>;
	/** Override `Date.now` for tests. */
	clock?: () => number;
};

const defaultKeyResolvers = (
	resolver: KeyResolver,
	trustedProxies: number,
	ipv6Prefix: number,
) => {
	if (resolver === 'ip') {
		return (ctx: RateLimitContext) => {
			const connectionIp = ctx.server?.requestIP?.(ctx.request)?.address ?? null;
			return extractIp({
				connectionIp,
				headers: ctx.request.headers,
				ipv6Prefix,
				trustedProxies,
			});
		};
	}
	if (resolver === 'authorization') {
		return (ctx: RateLimitContext) => ctx.request.headers.get('authorization') ?? 'anonymous';
	}
	return (ctx: RateLimitContext) => resolver(ctx) ?? 'unknown';
};

export const rateLimit = (options: RateLimitOptions) => {
	const store = options.store ?? memoryStore();
	const headerMode = options.headers ?? 'standard';
	const clock = options.clock ?? Date.now;
	const keyOf = defaultKeyResolvers(
		options.key ?? 'ip',
		options.trustedProxies ?? 0,
		options.ipv6Prefix ?? 64,
	);
	const skip = options.skip;
	const onLimit = options.onLimit;

	return new Elysia({ name: '@absolutejs/rate-limit' }).onRequest(
		async ({ request, server, set }) => {
			const rlCtx: RateLimitContext = {
				request,
				server: server as { requestIP?: (request: Request) => { address: string } | null } | null,
			};
			if (skip && skip(rlCtx)) return;

			const key = keyOf(rlCtx);
			const decisionRet = options.algorithm.check(store, key, clock());
			const decision = decisionRet instanceof Promise ? await decisionRet : decisionRet;
			const headers = formatHeaders(decision, headerMode);
			for (const [name, value] of Object.entries(headers)) {
				set.headers[name] = value;
			}

			if (decision.allowed) return;

			if (onLimit) {
				const custom = await onLimit(rlCtx, { decision, key });
				if (custom !== false) return custom;
			}
			return new Response('Too Many Requests', {
				headers: { 'Content-Type': 'text/plain', ...headers },
				status: 429,
			});
		},
	);
};
