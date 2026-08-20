/**
 * Elysia plugin entry point. Marked as a peer dep so non-Elysia callers can
 * import `@absolutejs/rate-limit/core` without pulling Elysia.
 */

import { Elysia } from 'elysia';
import {
	ABS_ATTRS,
	tracerOrNoop,
	type TracerProvider
} from '@absolutejs/telemetry';
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
	 * Namespace prefix prepended to every store key the plugin writes.
	 * Default the plugin's Elysia name (`'@absolutejs/rate-limit'`). When
	 * mounting two `rateLimit()` plugins against the same `Store` instance,
	 * set distinct `namespace` strings on each to prevent cross-plugin key
	 * collisions.
	 */
	namespace?: string;
	/**
	 * How to derive the per-request rate-limit key. `'ip'` (default) uses
	 * `extractIp` with the `trustedProxies` / `ipv6Prefix` options below.
	 * `'authorization'` uses the `Authorization` header (good for an
	 * authenticated API where IPs aren't stable). Or pass a function for
	 * any custom shape.
	 */
	key?: KeyResolver;
	/**
	 * Cost of the current request in algorithm units. Default `1` per
	 * request. Use this to charge expensive endpoints more (e.g. a bulk
	 * upload that should consume 10× the budget) or to free-list specific
	 * routes (`cost: 0`).
	 */
	cost?: number | ((ctx: RateLimitContext) => number);
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
	/**
	 * Hook fired on every allowed request, AFTER headers are set. Symmetric
	 * with `onLimit` but only fires when the request was let through. Useful
	 * for billing-event emission, per-tenant counters, or audit logs.
	 */
	onAllow?: (ctx: RateLimitContext, info: LimitInfo) => void | Promise<void>;
	/** Override `Date.now` for tests. */
	clock?: () => number;
	/**
	 * Optional OpenTelemetry tracer provider. When set, every limit
	 * check emits a `ratelimit.check` span with `abs.tenant` (the
	 * resolved key) and decision attributes. When omitted, all tracing
	 * is a zero-allocation noop. Added in 0.3.0.
	 *
	 * Structural type via `@absolutejs/telemetry`; no peer-dep on
	 * `@opentelemetry/api`. The non-Elysia core (`algorithm.check`,
	 * `Store`) is intentionally NOT wrapped — the plugin layer is
	 * where rate-limit decisions become observable to a customer SRE.
	 */
	tracerProvider?: TracerProvider;
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
	const onAllow = options.onAllow;
	const namespace = options.namespace ?? '@absolutejs/rate-limit';
	const fixedCost: number = typeof options.cost === 'number' ? options.cost : 1;
	const costOf: (ctx: RateLimitContext) => number = typeof options.cost === 'function'
		? options.cost
		: () => fixedCost;
	// 0.3.0: OTel tracer (noop when options.tracerProvider unset).
	const tracer = tracerOrNoop(options.tracerProvider, '@absolutejs/rate-limit');

	return new Elysia({ name: namespace }).request(
		async ({ request, server, set }) => {
			const rlCtx: RateLimitContext = {
				request,
				server: server as { requestIP?: (request: Request) => { address: string } | null } | null,
			};
			if (skip && skip(rlCtx)) return;

			const key = `${namespace}:${keyOf(rlCtx)}`;
			const cost = costOf(rlCtx);
			// 0.3.0: span the limit check. abs.tenant carries the
			// resolved key (IP, auth, or custom). On decision we add
			// allowed + remaining + retryAfter.
			const span = tracer.startSpan('ratelimit.check', {
				attributes: {
					[ABS_ATTRS.tenant]: key,
					'ratelimit.cost': cost
				}
			});
			try {
				const decisionRet = options.algorithm.check(store, key, clock(), cost);
				const decision = decisionRet instanceof Promise ? await decisionRet : decisionRet;
				span.setAttribute('ratelimit.allowed', decision.allowed);
				span.setAttribute('ratelimit.remaining', decision.remaining);
				if (!decision.allowed) {
					span.setAttribute('ratelimit.retry_after_sec', decision.retryAfterSec);
				}
				span.setStatus({ code: decision.allowed ? 1 /* OK */ : 2 /* ERROR */ });
				const headers = formatHeaders(decision, headerMode);
				for (const [name, value] of Object.entries(headers)) {
					set.headers[name] = value;
				}

				if (decision.allowed) {
					if (onAllow) {
						const ret = onAllow(rlCtx, { decision, key });
						if (ret instanceof Promise) {
							ret.catch((error) => {
								console.error('[rate-limit] onAllow rejected:', error);
							});
						}
					}
					return;
				}

				if (onLimit) {
					const custom = await onLimit(rlCtx, { decision, key });
					if (custom !== false) return custom;
				}
				return new Response('Too Many Requests', {
					headers: { 'Content-Type': 'text/plain', ...headers },
					status: 429,
				});
			} finally {
				span.end();
			}
		},
	);
};
