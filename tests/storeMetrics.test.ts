import { describe, expect, test } from 'bun:test';
import { gcra, memoryStore } from '../src/core';

describe('Store.metrics() — 0.2.0', () => {
	test('starts with zeroed cumulative counters', () => {
		const store = memoryStore();
		expect(store.metrics?.()).toEqual({
			deletes: 0,
			evictions: 0,
			size: 0,
			updates: 0
		});
	});

	test('updates counter bumps per update() call', () => {
		const store = memoryStore();
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		algo.check(store, 'k1', 1000);
		algo.check(store, 'k2', 1000);
		algo.check(store, 'k1', 1001);
		const m = store.metrics!();
		expect(m.updates).toBe(3);
		expect(m.size).toBe(2);
	});

	test('size reflects un-evicted entries', () => {
		const store = memoryStore({ maxKeys: 2 });
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		algo.check(store, 'a', 1000);
		algo.check(store, 'b', 1000);
		expect(store.metrics!().size).toBe(2);
		algo.check(store, 'c', 1000);
		expect(store.metrics!().size).toBe(2);
		expect(store.metrics!().evictions).toBe(1);
	});

	test('evictions counter climbs as LRU sheds keys', () => {
		const store = memoryStore({ maxKeys: 3 });
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
			algo.check(store, k, 1000);
		}
		const m = store.metrics!();
		expect(m.size).toBe(3);
		expect(m.evictions).toBe(3);
		expect(m.updates).toBe(6);
	});

	test('deletes counter tracks explicit delete() calls', () => {
		const store = memoryStore();
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		algo.check(store, 'k1', 1000);
		algo.check(store, 'k2', 1000);
		store.delete?.('k1');
		store.delete?.('k1'); // already gone — should NOT count
		store.delete?.('k2');
		const m = store.metrics!();
		expect(m.deletes).toBe(2);
		expect(m.size).toBe(0);
	});

	test('clear() counts every present key as deleted', () => {
		const store = memoryStore();
		const algo = gcra({ burst: 5, periodMs: 1000, requestsPerPeriod: 10 });
		algo.check(store, 'a', 1000);
		algo.check(store, 'b', 1000);
		algo.check(store, 'c', 1000);
		store.clear?.();
		const m = store.metrics!();
		expect(m.deletes).toBe(3);
		expect(m.size).toBe(0);
	});
});
