import { describe, expect, test } from 'bun:test';
import { extractIp, formatHeaders, normalizeIp } from '../src/core';

const h = (entries: Record<string, string>): Headers => {
	const out = new Headers();
	for (const [k, v] of Object.entries(entries)) out.set(k, v);
	return out;
};

describe('extractIp — XFF trust modes', () => {
	test('trustedProxies: 0 ignores XFF entirely; uses connection IP', () => {
		const ip = extractIp({
			connectionIp: '10.0.0.5',
			headers: h({ 'x-forwarded-for': '1.2.3.4' }),
			trustedProxies: 0,
		});
		expect(ip).toBe('10.0.0.5');
	});

	test('trustedProxies: 1 takes the rightmost of XFF (one trusted hop)', () => {
		const ip = extractIp({
			connectionIp: '10.0.0.5',
			headers: h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 10.0.0.5' }),
			trustedProxies: 1,
		});
		expect(ip).toBe('10.0.0.5');
	});

	test('trustedProxies: 2 honors two hops back', () => {
		const ip = extractIp({
			connectionIp: '10.0.0.5',
			headers: h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 10.0.0.5' }),
			trustedProxies: 2,
		});
		expect(ip).toBe('2.2.2.2');
	});

	test('trustedProxies > hops falls back to the leftmost (originator)', () => {
		const ip = extractIp({
			connectionIp: null,
			headers: h({ 'x-forwarded-for': '1.1.1.1' }),
			trustedProxies: 5,
		});
		expect(ip).toBe('1.1.1.1');
	});

	test('honors cf-connecting-ip when XFF is missing and proxies are trusted', () => {
		const ip = extractIp({
			connectionIp: '10.0.0.5',
			headers: h({ 'cf-connecting-ip': '203.0.113.7' }),
			trustedProxies: 1,
		});
		expect(ip).toBe('203.0.113.7');
	});

	test('falls back to "unknown" when nothing identifies the requester', () => {
		const ip = extractIp({ connectionIp: null, headers: h({}) });
		expect(ip).toBe('unknown');
	});
});

describe('normalizeIp — IPv6 /64 grouping', () => {
	test('groups IPv6 by /64 by default', () => {
		expect(normalizeIp('2001:db8:1234:5678:abcd:ef00:1234:5678')).toBe(
			'2001:db8:1234:5678:0:0:0:0/64',
		);
		expect(normalizeIp('2001:db8:1234:5678:9999:9999:9999:9999')).toBe(
			'2001:db8:1234:5678:0:0:0:0/64',
		);
	});

	test('respects a custom prefix', () => {
		expect(normalizeIp('2001:db8:1234:5678::1', 32)).toBe('2001:db8:0:0:0:0:0:0/32');
	});

	test('128 disables grouping', () => {
		expect(normalizeIp('2001:db8::1', 128)).toBe('2001:db8::1');
	});

	test('strips brackets + port on IPv6', () => {
		expect(normalizeIp('[2001:db8::1]:8080', 128)).toBe('2001:db8::1');
	});

	test('strips port on IPv4', () => {
		expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
	});

	test('strips zone id', () => {
		expect(normalizeIp('fe80::1%eth0', 128)).toBe('fe80::1');
	});

	test('IPv4-mapped IPv6 returns the IPv4', () => {
		expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
	});
});

describe('formatHeaders', () => {
	test('standard mode emits IETF draft-09 RateLimit + Policy', () => {
		const h = formatHeaders({
			allowed: true,
			limit: 100,
			policy: '100;w=60',
			remaining: 42,
			resetSec: 15,
			retryAfterSec: 0,
		}, 'standard');
		expect(h['RateLimit']).toBe('limit=100, remaining=42, reset=15');
		expect(h['RateLimit-Policy']).toBe('100;w=60');
		expect(h['X-RateLimit-Limit']).toBeUndefined();
	});

	test('legacy mode emits X-RateLimit-*', () => {
		const h = formatHeaders({
			allowed: true,
			limit: 100,
			policy: '100;w=60',
			remaining: 42,
			resetSec: 15,
			retryAfterSec: 0,
		}, 'legacy');
		expect(h['X-RateLimit-Limit']).toBe('100');
		expect(h['X-RateLimit-Remaining']).toBe('42');
		expect(h['X-RateLimit-Reset']).toBe('15');
		expect(h['RateLimit']).toBeUndefined();
	});

	test('both emits both', () => {
		const h = formatHeaders({
			allowed: true,
			limit: 100,
			policy: '100;w=60',
			remaining: 42,
			resetSec: 15,
			retryAfterSec: 0,
		}, 'both');
		expect(h['RateLimit']).toBeDefined();
		expect(h['X-RateLimit-Limit']).toBeDefined();
	});

	test('false suppresses everything except Retry-After', () => {
		const h = formatHeaders({
			allowed: false,
			limit: 100,
			policy: '100;w=60',
			remaining: 0,
			resetSec: 15,
			retryAfterSec: 5,
		}, false);
		expect(h['Retry-After']).toBe('5');
		expect(h['RateLimit']).toBeUndefined();
	});

	test('Retry-After only on a refused request', () => {
		const allowed = formatHeaders({
			allowed: true,
			limit: 100,
			policy: '100;w=60',
			remaining: 99,
			resetSec: 60,
			retryAfterSec: 0,
		});
		expect(allowed['Retry-After']).toBeUndefined();
	});
});
