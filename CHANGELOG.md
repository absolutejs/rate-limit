# @absolutejs/rate-limit changelog

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
