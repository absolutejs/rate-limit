# @absolutejs/rate-limit changelog

## 0.1.0 — 2026-05-29

Same-day deepening pass. Fully backwards-compatible — all existing call
sites continue to work; new surface is purely additive.

### Added

- **Multi-cost requests.** `algorithm.check(store, key, now, cost?)` now
  accepts an optional `cost` (default 1). The plugin option `cost: number |
  (ctx) => number` makes per-request cost a function of context — heavy
  endpoints can charge more, free-tier endpoints can charge 0. Semantics:
  if you'd be allowed at all, your cost-N goes through and overdraws future
  capacity (you "wait it off" — same as Stripe's metered approach).
- **`algorithm.peek(store, key, now)`** — read-only inspection. Returns the
  current decision *as if* a cost-0 request just arrived. Use this for
  status pages, quota displays, and "you have N requests left" surfaces
  without consuming a token.
- **`algorithm.reset(store, key)`** — clear a key's state. Admin tooling
  for "this customer is locked out by mistake; reset their bucket."
- **`combined({ algorithms: [a, b] })`** — composes multiple algorithms
  into one that passes only when every component passes. Standard stacked
  shape: "100/minute per IP **AND** 10000/day per user-id" in a single
  `rateLimit()` plugin. The composed `policy` carries every component's
  descriptor; the composed `limit` is the tightest. Auto-namespaces keys
  per component to avoid collision in a shared store.
- **Plugin `namespace` option.** All store keys are prefixed with the
  namespace. Default = the plugin's Elysia name. Mount two `rateLimit()`
  plugins against the same `Store` instance with distinct namespaces and
  their keys never collide.
- **Plugin `onAllow` hook.** Symmetric with `onLimit` — fires on every
  allowed request, after headers are set. Useful for billing-event
  emission, per-tenant counters, or audit logs.

## 0.0.1 — 2026-05-29

Initial release.

### Algorithms (`src/algorithms.ts`)

- **`gcra({ requestsPerPeriod, periodMs, burst? })`** — Generic Cell Rate
  Algorithm. Default. Exact, O(1) memory per key (one BigInt of TAT — the
  theoretical arrival time, in nanoseconds for drift-free arithmetic). The
  algorithm Stripe uses; no boundary effects.
- **`tokenBucket({ capacity, refillPerSecond })`** — classic. Allows brief
  bursts up to capacity. O(1) memory.
- **`slidingWindow({ requestsPerPeriod, periodMs })`** — sliding-window
  counter (approximate). O(1) memory. Useful when "last N seconds" budgets
  are easier to explain to customers.

### Store

- **`memoryStore({ maxKeys?, defaultTtlMs?, clock? })`** — LRU + lazy TTL.
  Sync (algorithms benefit). `maxKeys` default `100_000`. Redis / Postgres
  adapters ship as siblings.

### IP extraction

- **`extractIp({ connectionIp, headers, trustedProxies?, ipv6Prefix? })`** —
  honors `X-Forwarded-For` only up to `trustedProxies` hops; falls back to
  `cf-connecting-ip`, `fly-client-ip`, `true-client-ip`, `x-real-ip` in
  that order when XFF is absent and a proxy is trusted. IPv6 addresses are
  grouped by `/64` by default (RIR convention) — one user is one cap, not
  one cap per `/128`. Configurable.

### Headers

- **IETF draft-ietf-httpapi-ratelimit-headers (`'standard'`, default)** —
  `RateLimit: limit=, remaining=, reset=` + `RateLimit-Policy`.
- **Legacy (`'legacy'`)** — `X-RateLimit-Limit` / `-Remaining` / `-Reset`.
- **`'both'`** — emit both for transition periods.
- **`false`** — suppress rate-limit headers (Retry-After still sent on 429s).

### Elysia plugin

- **`rateLimit({ algorithm, store?, key?, skip?, headers?, trustedProxies?, ipv6Prefix?, onLimit?, clock? })`**
  exports as `@absolutejs/rate-limit` (top-level) and
  `@absolutejs/rate-limit/elysia` (alone). Pure-core algorithms also
  available at `@absolutejs/rate-limit/core` for non-Elysia usage.
- Key resolvers: `'ip'` (default, uses extractIp), `'authorization'`
  (header), or any `(ctx) => string | null`.
- `skip` is sync — for async, fold the decision into `key`.
- `onLimit` lets the caller customize the 429 response.

### Non-goals (later)

- Redis / Postgres store adapters (siblings).
- WebSocket-message-level rate limiting (different shape; separate plugin).
- Distributed coordination beyond Redis Lua atomic scripts (v0.2+).
