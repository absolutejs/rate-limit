import {
	defineImplementation,
	defineManifest,
	toolFactory
} from '@absolutejs/manifest';
import { Type } from '@sinclair/typebox';
import type {
	GcraOptions,
	SlidingWindowOptions,
	TokenBucketOptions
} from './algorithms';
import type { RateLimitOptions } from './elysia';
import type { MemoryStoreOptions } from './stores';
import type { Algorithm, Store } from './types';

/* The instance the host binds for runtime tools: the algorithm + store pair
 * the plugin was constructed with. */
type RateLimitRuntime = { algorithm: Algorithm; store: Store };

const tool = toolFactory<RateLimitRuntime>();

const IPV6_MAX_PREFIX = 128;

/* Serializable subset of RateLimitOptions. `algorithm` and `store` are
 * instance-valued → slots; `key` (function arm), `cost` (function arm),
 * `skip`, `onLimit`, `onAllow`, `clock`, `tracerProvider` are
 * function-valued → wiring concerns. */
export const manifest = defineManifest<RateLimitOptions, RateLimitRuntime>()({
	contract: 1,
	identity: {
		accent: '#ef4444',
		category: 'infrastructure',
		description:
			'GCRA-first rate limiting for Bun + Elysia: exact O(1) limiting with no boundary bursts (the algorithm Stripe uses), plus token bucket and sliding window. IETF draft-09 `RateLimit-*` headers, IPv6 /64 grouping, X-Forwarded-For trust modes, per-request cost, and pluggable stores (memory LRU bundled).',
		docsUrl: 'https://github.com/absolutejs/rate-limit',
		name: '@absolutejs/rate-limit',
		tagline:
			'Stop abusive traffic by capping how fast anyone can hit your site.'
	},
	implements: [
		defineImplementation<GcraOptions>()({
			contract: 'rate-limit/algorithm',
			factory: 'gcra',
			from: '@absolutejs/rate-limit/core',
			settings: Type.Object({
				burst: Type.Optional(
					Type.Integer({
						description:
							'Extra back-to-back requests allowed beyond the steady rate. 0 means none.',
						minimum: 0,
						title: 'Burst allowance'
					})
				),
				periodMs: Type.Integer({
					description:
						'Length of the window in milliseconds, e.g. 60000 for one minute.',
					minimum: 1,
					title: 'Time window (ms)'
				}),
				requestsPerPeriod: Type.Integer({
					description:
						'How many requests each visitor gets per time window.',
					minimum: 1,
					title: 'Requests allowed'
				})
			}),
			title: 'Smooth limiting (GCRA — recommended)',
			wiring: {
				code: 'gcra(${settings})',
				imports: [
					{ from: '@absolutejs/rate-limit/core', names: ['gcra'] }
				]
			}
		}),
		defineImplementation<TokenBucketOptions>()({
			contract: 'rate-limit/algorithm',
			factory: 'tokenBucket',
			from: '@absolutejs/rate-limit/core',
			settings: Type.Object({
				capacity: Type.Integer({
					description:
						'How many requests fit in the bucket — the largest burst a visitor can spend at once.',
					minimum: 1,
					title: 'Bucket size'
				}),
				refillPerSecond: Type.Number({
					description:
						'How many requests are added back to the bucket every second.',
					minimum: 0,
					title: 'Refill per second'
				})
			}),
			title: 'Token bucket (allows bursts)',
			wiring: {
				code: 'tokenBucket(${settings})',
				imports: [
					{
						from: '@absolutejs/rate-limit/core',
						names: ['tokenBucket']
					}
				]
			}
		}),
		defineImplementation<SlidingWindowOptions>()({
			contract: 'rate-limit/algorithm',
			factory: 'slidingWindow',
			from: '@absolutejs/rate-limit/core',
			settings: Type.Object({
				periodMs: Type.Integer({
					description:
						'Length of the rolling window in milliseconds, e.g. 60000 for one minute.',
					minimum: 1,
					title: 'Time window (ms)'
				}),
				requestsPerPeriod: Type.Integer({
					description:
						'How many requests each visitor gets within the rolling window.',
					minimum: 1,
					title: 'Requests allowed'
				})
			}),
			title: 'Sliding window (easy to explain, approximate)',
			wiring: {
				code: 'slidingWindow(${settings})',
				imports: [
					{
						from: '@absolutejs/rate-limit/core',
						names: ['slidingWindow']
					}
				]
			}
		}),
		defineImplementation<MemoryStoreOptions>()({
			contract: 'rate-limit/store',
			factory: 'memoryStore',
			from: '@absolutejs/rate-limit/core',
			settings: Type.Object({
				defaultTtlMs: Type.Optional(
					Type.Integer({
						description:
							'Fallback lifetime for counter entries in milliseconds when the algorithm does not set one. Default is one hour.',
						minimum: 1,
						title: 'Fallback entry lifetime (ms)'
					})
				),
				maxKeys: Type.Optional(
					Type.Integer({
						description:
							'Hard cap on tracked visitors before the oldest are dropped. Default is 100,000.',
						minimum: 1,
						title: 'Max tracked visitors'
					})
				)
			}),
			title: "This server's memory (good default)",
			wiring: {
				code: 'memoryStore(${settings})',
				imports: [
					{
						from: '@absolutejs/rate-limit/core',
						names: ['memoryStore']
					}
				]
			}
		})
	],
	requires: {
		peers: [{ name: 'elysia', range: '>= 1.0.0', reason: 'plugin host' }]
	},
	settings: Type.Object({
		cost: Type.Optional(
			Type.Number({
				description:
					'How many units of the budget one request spends. Default is 1.',
				minimum: 0,
				title: 'Cost per request'
			})
		),
		headers: Type.Optional(
			Type.Union(
				[
					Type.Literal('standard'),
					Type.Literal('legacy'),
					Type.Literal('both'),
					Type.Literal(false)
				],
				{
					description:
						"Which rate-limit headers responses carry: 'standard' (IETF RateLimit-*), 'legacy' (X-RateLimit-*), 'both', or false for none. Retry-After is always sent on 429s.",
					title: 'Rate-limit headers',
					'x-group': 'advanced'
				}
			)
		),
		ipv6Prefix: Type.Optional(
			Type.Integer({
				description:
					'IPv6 visitors are grouped by this prefix length so one person cannot dodge the limit by rotating addresses. Default is 64.',
				maximum: IPV6_MAX_PREFIX,
				minimum: 0,
				title: 'IPv6 grouping prefix',
				'x-group': 'advanced'
			})
		),
		key: Type.Optional(
			Type.Union([Type.Literal('ip'), Type.Literal('authorization')], {
				description:
					"How visitors are told apart: 'ip' uses their network address (default); 'authorization' uses the Authorization header — better for authenticated APIs.",
				title: 'Count requests per'
			})
		),
		namespace: Type.Optional(
			Type.String({
				description:
					'Prefix on every stored counter key. Set distinct values when two limiters share one store.',
				title: 'Counter namespace',
				'x-group': 'advanced'
			})
		),
		trustedProxies: Type.Optional(
			Type.Integer({
				description:
					'How many proxies (load balancers, CDNs) sit in front of the app. Used to read the real visitor address from X-Forwarded-For. Default is 0.',
				minimum: 0,
				title: 'Trusted proxies in front',
				'x-group': 'advanced'
			})
		)
	}),
	slots: {
		algorithm: {
			configPath: 'algorithm',
			contract: 'rate-limit/algorithm',
			description: 'How request budgets are counted',
			known: [
				'@absolutejs/rate-limit#gcra',
				'@absolutejs/rate-limit#token-bucket',
				'@absolutejs/rate-limit#sliding-window'
			],
			required: true
		},
		store: {
			configPath: 'store',
			contract: 'rate-limit/store',
			description:
				'Where per-visitor counters are kept (defaults to this server’s memory)',
			known: ['@absolutejs/rate-limit#memory']
		}
	},
	tools: {
		check_rate_limit: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				"Inspect one visitor's current rate-limit state (allowed, remaining, reset) without spending any budget. `key` is the full store key including the namespace prefix, e.g. '@absolutejs/rate-limit:203.0.113.9'.",
			handler: async ({ key }, { algorithm, store }) =>
				JSON.stringify(await algorithm.peek(store, key, Date.now())),
			input: Type.Object({ key: Type.String({ minLength: 1 }) })
		}),
		limiter_stats: tool.runtime({
			annotations: { readOnlyHint: true },
			description:
				'Counter-store statistics: tracked keys, total decisions, LRU evictions, deletes. Climbing evictions mean the store is undersized.',
			handler: (_input, { store }) =>
				store.metrics
					? JSON.stringify(store.metrics())
					: 'this store does not expose counters',
			input: Type.Object({})
		}),
		reset_rate_limit: tool.runtime({
			annotations: { destructiveHint: true, idempotentHint: true },
			description:
				"Clear one visitor's rate-limit state so they get a fresh budget. `key` is the full store key including the namespace prefix.",
			handler: async ({ key }, { algorithm, store }) => {
				await algorithm.reset(store, key);

				return `reset rate-limit state for ${key}`;
			},
			input: Type.Object({ key: Type.String({ minLength: 1 }) })
		})
	},
	wiring: [
		{
			description:
				'Every request is checked before your routes run; blocked visitors get a 429 with Retry-After.',
			id: 'default',
			server: {
				code: [
					'.use(',
					'\trateLimit({',
					'\t\talgorithm: ${slot.algorithm},',
					'\t\tcost: ${settings.cost},',
					'\t\theaders: ${settings.headers},',
					'\t\tipv6Prefix: ${settings.ipv6Prefix},',
					'\t\tkey: ${settings.key},',
					'\t\tnamespace: ${settings.namespace},',
					'\t\tstore: ${slot.store},',
					'\t\ttrustedProxies: ${settings.trustedProxies}',
					'\t})',
					')'
				].join('\n'),
				imports: [
					{ from: '@absolutejs/rate-limit', names: ['rateLimit'] }
				],
				placement: 'server-plugin'
			},
			title: 'Limit request rates site-wide'
		}
	]
});
