/**
 * Non-Elysia entry point: algorithms + store + IP/header helpers. Use this
 * if you want rate-limiting outside HTTP (e.g. WebSocket message rate
 * limiting, queue-consumer throttling, AI-call throttling).
 */

export type {
	Algorithm,
	RateLimitDecision,
	Store,
	StoreMetrics
} from './types';
export {
	gcra,
	slidingWindow,
	tokenBucket,
	type GcraOptions,
	type SlidingWindowOptions,
	type TokenBucketOptions,
} from './algorithms';
export { memoryStore, type MemoryStoreOptions } from './stores';
export { extractIp, normalizeIp, type IpExtractOptions } from './ip';
export { formatHeaders, type HeaderMode } from './headers';
export { combined, type CombinedOptions } from './combined';
