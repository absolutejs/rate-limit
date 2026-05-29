# @absolutejs/rate-limit

First-class, from-scratch, 2026 rate limit for Bun + Elysia. **GCRA by default**
(the algorithm Stripe uses — exact, O(1) memory per key, no boundary effects),
**IETF draft-09 `RateLimit-*` headers**, **IPv6 /64 grouping**,
**`X-Forwarded-For` trust modes**, **BigInt nanosecond TAT** (no float drift),
pluggable store (LRU in-memory bundled).

```ts
import { Elysia } from 'elysia';
import { rateLimit, gcra } from '@absolutejs/rate-limit';

new Elysia()
  .use(rateLimit({
    algorithm: gcra({ requestsPerPeriod: 100, periodMs: 60_000, burst: 20 }),
    key: 'ip',
    trustedProxies: 1, // single CDN/LB hop trusted
  }))
  .get('/', () => 'ok')
  .listen(3000);
```

## Why not just use the existing libraries

The leader in the Elysia ecosystem is rayriffy/elysia-rate-limit. It uses a
token bucket over a `Map` with a `setInterval` cleanup. That's fine, but every
choice in it is from 2020. The 2026 from-scratch answers:

| Concern | What others do | What we do |
|---|---|---|
| **Algorithm** | Token bucket (allows brief bursts at refill boundaries) | **GCRA** by default. Exact, no boundary effect, one BigInt of state per key. Token bucket and sliding window also bundled when you want them. |
| **Time precision** | `Date.now()` ms (float drift over long-lived keys) | **BigInt nanoseconds** for GCRA TAT. Drift-free over any horizon. |
| **IPv6** | Per-/128 (one cap per device — a `/64` user with N devices gets N× their cap) | **Per-/64 group** by default (RIR allocation = one user). Configurable. |
| **Proxy trust** | Trust `X-Forwarded-For` blindly OR ignore it | `trustedProxies: N` — honor only the last N hops; spoof-resistant by default (`N=0`). |
| **Headers** | `X-RateLimit-*` (legacy GitHub-style) | **IETF draft-09 `RateLimit-*` + `RateLimit-Policy`** by default. Legacy + `both` modes also available. |
| **Store cleanup** | `setInterval` sweeper (timer per process; lock contention on iteration) | **Lazy TTL** at lookup time. No background timer. |
| **Hot path** | Async even on memory store | **Sync when the store is sync**, async only when it has to be. |
| **CDN headers** | XFF only | XFF + `cf-connecting-ip` + `fly-client-ip` + `true-client-ip` + `x-real-ip`. |

## Surface

### Elysia plugin (`@absolutejs/rate-limit`)

```ts
rateLimit({
  algorithm: gcra({ requestsPerPeriod: 100, periodMs: 60_000, burst: 20 }),
  store: memoryStore({ maxKeys: 100_000 }),

  // key — defaults to 'ip' (uses extractIp).
  key: 'ip',                                                   // built-in
  // key: 'authorization',                                       // built-in
  // key: (ctx) => ctx.request.headers.get('x-user') ?? null,    // custom

  trustedProxies: 1,         // honor only the last hop of XFF (typical: 1)
  ipv6Prefix: 64,            // group IPv6 by /64

  skip: (ctx) => ctx.request.headers.get('authorization') === ADMIN_TOKEN,

  headers: 'standard',       // 'standard' | 'legacy' | 'both' | false

  onLimit: (ctx, info) => new Response(JSON.stringify({
    ok: false,
    retryAfterSec: info.decision.retryAfterSec,
  }), { status: 429, headers: { 'Content-Type': 'application/json' } }),
})
```

### Algorithms (`@absolutejs/rate-limit/core`)

```ts
import { gcra, tokenBucket, slidingWindow, memoryStore } from '@absolutejs/rate-limit/core';

const limiter = gcra({ requestsPerPeriod: 100, periodMs: 60_000, burst: 20 });
const store = memoryStore();
const decision = limiter.check(store, 'user-42', Date.now());
// → { allowed, limit, remaining, retryAfterSec, resetSec, policy }
```

Use the core directly for non-HTTP rate-limiting — WebSocket-message rate
limiting, queue-consumer throttling, AI-call quotas.

### Store interface

```ts
type Store = {
  update<T>(key: string, ttlMs: number, fn: (prev: T | null) => T): T | Promise<T>;
  delete?(key: string): void | Promise<void>;
  clear?(): void | Promise<void>;
};
```

Implement `update` atomically (read-modify-write); the rest is optional. For
Bun in-process: `memoryStore()`. For multi-replica Bun deployments: Redis
with a Lua script for GCRA atomicity (sibling package, `@absolutejs/rate-limit-redis`,
ships later).

## Algorithm picker

- **GCRA** — pick this unless you have a reason not to. Exact, O(1) memory,
  no boundary effects, BigInt math = no drift. Burst is configurable; set
  `burst: 0` for strict pacing.
- **Token bucket** — pick this when you specifically WANT the "fill the
  bucket and let the user fire it all at once" behavior. Cleaner mental
  model for end-users.
- **Sliding window** — pick this when the customer-facing story is "you
  have N requests in the last M seconds." It's an approximation that can
  under-count by ~1 slot at heavy clustering, but it's the most intuitive
  to explain on a status page.

## License

BSL 1.1 with a named carveout for the hosted rate-limit / WAF / API gateway throttling category (Cloudflare WAF + Rate Limiting, AWS WAF + API Gateway throttling, Kong, Tyk, Imperva, Akamai, GCP Cloud Armor, Azure Front Door rate-limiting, Upstash Ratelimit, Stripe's API gateway throttling). See [LICENSE](./LICENSE). Change Date: 4 years from first release; Change License: Apache 2.0.
