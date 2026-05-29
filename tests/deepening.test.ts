import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
	combined,
	gcra,
	memoryStore,
	rateLimit,
	slidingWindow,
	tokenBucket,
	type Algorithm,
} from '../src';

const sync = (algo: Algorithm, store = memoryStore(), key = 'k') =>
	(now: number, cost?: number) => {
		const ret = algo.check(store, key, now, cost);
		if (ret instanceof Promise) throw new Error('expected sync');
		return ret;
	};

describe('multi-cost requests', () => {
	test('tokenBucket charges N tokens per request', () => {
		const algo = tokenBucket({ capacity: 10, refillPerSecond: 0 });
		const check = sync(algo);
		expect(check(0, 5).allowed).toBe(true);
		expect(check(0, 5).allowed).toBe(true);
		expect(check(0, 1).allowed).toBe(false);
	});

	test('tokenBucket cost > capacity denies without dropping below 0', () => {
		const algo = tokenBucket({ capacity: 10, refillPerSecond: 0 });
		const check = sync(algo);
		const denied = check(0, 15);
		expect(denied.allowed).toBe(false);
		// Bucket should still have 10 — no partial deduction.
		expect(check(0, 10).allowed).toBe(true);
	});

	test('gcra increment scales with cost', () => {
		const algo = gcra({ burst: 0, periodMs: 1000, requestsPerPeriod: 10 });
		const check = sync(algo);
		// At t=0 with cost=5, TAT jumps to 5T = 500ms.
		expect(check(0, 5).allowed).toBe(true);
		// Next call at t=0 should be denied — TAT is 500ms ahead.
		expect(check(0, 1).allowed).toBe(false);
		// At t=500, the previous 5-cost has just emitted; one more 1-cost fits.
		expect(check(500, 1).allowed).toBe(true);
	});

	test('cost=0 always allowed (free request)', () => {
		const algo = tokenBucket({ capacity: 1, refillPerSecond: 0 });
		const check = sync(algo);
		check(0); // drain the bucket
		expect(check(0, 0).allowed).toBe(true);
		expect(check(0, 0).allowed).toBe(true);
	});

	test('slidingWindow accumulates count by cost', () => {
		const algo = slidingWindow({ periodMs: 1000, requestsPerPeriod: 10 });
		const check = sync(algo);
		expect(check(0, 4).allowed).toBe(true);
		expect(check(0, 5).allowed).toBe(true);
		expect(check(0, 2).allowed).toBe(false);
		expect(check(0, 1).allowed).toBe(true);
	});

	test('negative cost throws', () => {
		const algo = tokenBucket({ capacity: 10, refillPerSecond: 0 });
		const store = memoryStore();
		expect(() => algo.check(store, 'k', 0, -1)).toThrow();
	});
});

describe('peek (read-only inspection)', () => {
	test('tokenBucket.peek does not consume', () => {
		const algo = tokenBucket({ capacity: 3, refillPerSecond: 0 });
		const store = memoryStore();
		const peek = () => {
			const ret = algo.peek(store, 'k', 0);
			if (ret instanceof Promise) throw new Error('sync');
			return ret;
		};
		expect(peek().remaining).toBe(3);
		expect(peek().remaining).toBe(3);
		expect(peek().remaining).toBe(3);

		// Now consume one and re-peek.
		const check = sync(algo, store, 'k');
		check(0);
		expect(peek().remaining).toBe(2);
	});

	test('gcra.peek shows the current burst credit without advancing TAT', () => {
		const algo = gcra({ burst: 4, periodMs: 1000, requestsPerPeriod: 10 });
		const store = memoryStore();
		const peek = () => {
			const ret = algo.peek(store, 'k', 0);
			if (ret instanceof Promise) throw new Error('sync');
			return ret;
		};
		const check = sync(algo, store, 'k');

		expect(peek().remaining).toBe(5);
		check(0);
		expect(peek().remaining).toBe(4);
		expect(peek().remaining).toBe(4); // peek twice — still 4
	});

	test('slidingWindow.peek does not increment', () => {
		const algo = slidingWindow({ periodMs: 1000, requestsPerPeriod: 5 });
		const store = memoryStore();
		const check = sync(algo, store, 'k');
		check(0); check(0);
		const ret = algo.peek(store, 'k', 0);
		if (ret instanceof Promise) throw new Error('sync');
		expect(ret.remaining).toBe(3);
		// Calling peek twice does not change remaining.
		const second = algo.peek(store, 'k', 0);
		if (second instanceof Promise) throw new Error('sync');
		expect(second.remaining).toBe(3);
	});
});

describe('reset (admin clear)', () => {
	test('tokenBucket.reset drops a key back to capacity', () => {
		const algo = tokenBucket({ capacity: 3, refillPerSecond: 0 });
		const store = memoryStore();
		const check = sync(algo, store, 'k');
		check(0); check(0); check(0);
		expect(check(0).allowed).toBe(false);

		algo.reset(store, 'k');
		expect(check(0).allowed).toBe(true);
	});

	test('gcra.reset clears TAT', () => {
		const algo = gcra({ burst: 0, periodMs: 1000, requestsPerPeriod: 10 });
		const store = memoryStore();
		const check = sync(algo, store, 'k');
		check(0);
		expect(check(0).allowed).toBe(false);
		algo.reset(store, 'k');
		expect(check(0).allowed).toBe(true);
	});
});

describe('combined (stacked limiters)', () => {
	test('passes only when every component passes', () => {
		const ip = tokenBucket({ capacity: 100, refillPerSecond: 0 });    // 100 per IP
		const user = tokenBucket({ capacity: 5, refillPerSecond: 0 });    // 5 per user — tighter
		const algo = combined({ algorithms: [ip, user] });
		const store = memoryStore();

		for (let i = 0; i < 5; i++) {
			const ret = algo.check(store, 'user-1', 0);
			if (ret instanceof Promise) throw new Error('sync');
			expect(ret.allowed).toBe(true);
		}
		const refused = algo.check(store, 'user-1', 0);
		if (refused instanceof Promise) throw new Error('sync');
		expect(refused.allowed).toBe(false);
		// The tighter limit drove `limit`.
		expect(refused.limit).toBe(5);
	});

	test('combined.peek returns the tightest of the two', () => {
		const a = tokenBucket({ capacity: 100, refillPerSecond: 0 });
		const b = tokenBucket({ capacity: 5, refillPerSecond: 0 });
		const algo = combined({ algorithms: [a, b] });
		const store = memoryStore();
		const ret = algo.peek(store, 'user-1', 0);
		if (ret instanceof Promise) throw new Error('sync');
		expect(ret.remaining).toBe(5);
		expect(ret.limit).toBe(5);
	});

	test('combined.reset clears every component', () => {
		const a = tokenBucket({ capacity: 1, refillPerSecond: 0 });
		const b = tokenBucket({ capacity: 1, refillPerSecond: 0 });
		const algo = combined({ algorithms: [a, b] });
		const store = memoryStore();
		algo.check(store, 'k', 0); // consume both
		const denied = algo.check(store, 'k', 0);
		if (denied instanceof Promise) throw new Error('sync');
		expect(denied.allowed).toBe(false);

		algo.reset(store, 'k');
		const fresh = algo.check(store, 'k', 0);
		if (fresh instanceof Promise) throw new Error('sync');
		expect(fresh.allowed).toBe(true);
	});

	test('cost propagates to every component', () => {
		const a = tokenBucket({ capacity: 10, refillPerSecond: 0 });
		const b = tokenBucket({ capacity: 10, refillPerSecond: 0 });
		const algo = combined({ algorithms: [a, b] });
		const store = memoryStore();
		const ret = algo.check(store, 'k', 0, 5);
		if (ret instanceof Promise) throw new Error('sync');
		expect(ret.allowed).toBe(true);
		expect(ret.remaining).toBe(5);
	});

	test('combined policy concatenates components', () => {
		const algo = combined({
			algorithms: [
				gcra({ burst: 0, periodMs: 60_000, requestsPerPeriod: 100 }),
				gcra({ burst: 0, periodMs: 86_400_000, requestsPerPeriod: 10_000 }),
			],
		});
		expect(algo.policy).toContain('100;w=60');
		expect(algo.policy).toContain('10000;w=86400');
		expect(algo.policy).toContain(',');
	});
});

describe('plugin: cost + onAllow + namespace', () => {
	test('cost can be a function of context — heavy routes cost more', async () => {
		const clock = { current: 1_000_000 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 10, refillPerSecond: 0 }),
				clock: () => clock.current,
				cost: (ctx) => ctx.request.url.includes('/heavy') ? 5 : 1,
				key: () => 'k',
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/heavy', () => 'ok')
			.get('/light', () => 'ok');

		// One heavy = 5, one light = 1 → 6 used.
		expect((await app.handle(new Request('http://localhost/heavy'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(200);
		// Another heavy = 5 → 11, refused.
		expect((await app.handle(new Request('http://localhost/heavy'))).status).toBe(429);
		// But three more lights fit (10 - 6 = 4 left).
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(200);
		expect((await app.handle(new Request('http://localhost/light'))).status).toBe(429);
	});

	test('onAllow fires per allowed request with the decision', async () => {
		const calls: number[] = [];
		const clock = { current: 1_000_000 };
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 3, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: () => 'k',
				onAllow: (_ctx, info) => { calls.push(info.decision.remaining); },
				store: memoryStore({ clock: () => clock.current }),
			}))
			.get('/', () => 'ok');

		await app.handle(new Request('http://localhost/'));
		await app.handle(new Request('http://localhost/'));
		await app.handle(new Request('http://localhost/'));
		await app.handle(new Request('http://localhost/')); // 429 — onAllow does NOT fire

		expect(calls).toEqual([2, 1, 0]);
	});

	test('two rateLimit plugins with different namespaces do not collide', async () => {
		const clock = { current: 1_000_000 };
		const sharedStore = memoryStore({ clock: () => clock.current });
		const app = new Elysia()
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 1, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: () => 'shared',
				namespace: 'plugin-a',
				store: sharedStore,
			}))
			.use(rateLimit({
				algorithm: tokenBucket({ capacity: 1, refillPerSecond: 0 }),
				clock: () => clock.current,
				key: () => 'shared',
				namespace: 'plugin-b',
				store: sharedStore,
			}))
			.get('/', () => 'ok');

		// Both plugins should let the first request through (separate buckets).
		const first = await app.handle(new Request('http://localhost/'));
		expect(first.status).toBe(200);
		// The second request should be refused by ONE of them (both buckets are now empty).
		const second = await app.handle(new Request('http://localhost/'));
		expect(second.status).toBe(429);
	});
});
