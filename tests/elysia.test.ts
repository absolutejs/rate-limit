import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { gcra, memoryStore, rateLimit, tokenBucket } from '../src';

const make = (clock: { current: number }) =>
	new Elysia()
		.use(
			rateLimit({
				algorithm: tokenBucket({ capacity: 3, refillPerSecond: 1 }),
				clock: () => clock.current,
				key: () => 'global',
				store: memoryStore({ clock: () => clock.current }),
			}),
		)
		.get('/', () => 'ok');

describe('rateLimit Elysia plugin', () => {
	test('allows up to capacity then returns 429', async () => {
		const clock = { current: 1_000_000 };
		const app = make(clock);
		const send = () => app.handle(new Request('http://localhost/'));
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(429);
	});

	test('429 response carries Retry-After + standard RateLimit headers', async () => {
		const clock = { current: 1_000_000 };
		const app = make(clock);
		const send = () => app.handle(new Request('http://localhost/'));
		await send(); await send(); await send();
		const refused = await send();
		expect(refused.status).toBe(429);
		expect(refused.headers.get('Retry-After')).not.toBeNull();
		expect(refused.headers.get('RateLimit')).toContain('limit=3');
		expect(refused.headers.get('RateLimit-Policy')).toBeDefined();
	});

	test('legacy header mode emits X-RateLimit-*', async () => {
		const clock = { current: 1_000_000 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 5, refillPerSecond: 1 }),
				clock: () => clock.current,
				headers: 'legacy',
				key: () => 'k',
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		const res = await app.handle(new Request('http://localhost/'));
		expect(res.headers.get('X-RateLimit-Limit')).toBe('5');
		expect(res.headers.get('X-RateLimit-Remaining')).toBe('4');
		expect(res.headers.get('RateLimit')).toBeNull();
	});

	test('skip predicate bypasses the limit', async () => {
		const clock = { current: 1_000_000 };
		const adminCalls: string[] = [];
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 1, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: () => 'k',
				skip: (ctx) => {
					const result = ctx.request.headers.get('authorization') === 'Bearer admin';
					adminCalls.push(String(result));
					return result;
				},
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		// Non-admin: 1 OK, then 429.
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(429);
		// Admin: every call passes despite the bucket being empty.
		const auth = { Authorization: 'Bearer admin' };
		expect((await app.handle(new Request('http://localhost/', { headers: auth }))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/', { headers: auth }))).status).toBe(200);
	});

	test('GCRA at the plugin layer enforces sustained rate', async () => {
		const clock = { current: 0 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: gcra({ burst: 1, periodMs: 1000, requestsPerPeriod: 10 }),
				clock: () => clock.current,
				key: () => 'k',
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		// Burst+1 = 2 should pass back-to-back.
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(429);

		// 100ms later (one emission interval) → one more passes.
		clock.current = 100;
		expect((await app.handle(new Request('http://localhost/'))).status).toBe(200);
	});

	test('onLimit override produces a custom response', async () => {
		const clock = { current: 1_000_000 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 1, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: () => 'k',
				onLimit: () => new Response(JSON.stringify({ ok: false, reason: 'slow_down' }), {
					headers: { 'Content-Type': 'application/json' },
					status: 429,
				}),
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		await app.handle(new Request('http://localhost/'));
		const refused = await app.handle(new Request('http://localhost/'));
		expect(refused.status).toBe(429);
		expect(refused.headers.get('Content-Type')).toBe('application/json');
		const json = await refused.json();
		expect(json.reason).toBe('slow_down');
	});

	test('per-key isolation: two distinct keys do not share a bucket', async () => {
		const clock = { current: 1_000_000 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 1, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: (ctx) => ctx.request.headers.get('x-tenant') ?? 'default',
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		const a = await app.handle(new Request('http://localhost/', { headers: { 'x-tenant': 'a' } }));
		expect(a.status).toBe(200);
		const aTooMany = await app.handle(new Request('http://localhost/', { headers: { 'x-tenant': 'a' } }));
		expect(aTooMany.status).toBe(429);

		// Tenant b is untouched.
		const b = await app.handle(new Request('http://localhost/', { headers: { 'x-tenant': 'b' } }));
		expect(b.status).toBe(200);
	});
});
