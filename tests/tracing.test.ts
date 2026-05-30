import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import {
	ABS_ATTRS,
	createNoopSpan,
	type Span,
	type Tracer,
	type TracerProvider
} from '@absolutejs/telemetry';
import { gcra } from '../src/core';
import { rateLimit } from '../src/elysia';

type CapturedSpan = {
	name: string;
	attrs: Record<string, unknown>;
	status?: { code: number };
	ended: boolean;
};

const makeCapturingTracerProvider = () => {
	const spans: CapturedSpan[] = [];
	const makeSpan = (record: CapturedSpan): Span => {
		const noop = createNoopSpan();
		return {
			...noop,
			end: () => {
				record.ended = true;
			},
			isRecording: () => !record.ended,
			setAttribute: ((key: string, value: unknown) => {
				record.attrs[key] = value;
				return makeSpan(record);
			}) as Span['setAttribute'],
			setStatus: ((status) => {
				record.status = status;
				return makeSpan(record);
			}) as Span['setStatus']
		};
	};
	const tracer: Tracer = {
		startActiveSpan: ((name, optionsOrFn, maybeFn) => {
			const fn =
				typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
			const record: CapturedSpan = { attrs: {}, ended: false, name };
			spans.push(record);
			return (fn as (s: Span) => unknown)(makeSpan(record));
		}) as Tracer['startActiveSpan'],
		startSpan: (name, options) => {
			const record: CapturedSpan = {
				attrs: { ...(options?.attributes ?? {}) },
				ended: false,
				name
			};
			spans.push(record);
			return makeSpan(record);
		}
	};
	const provider: TracerProvider = { getTracer: () => tracer };
	return { provider, spans };
};

describe('rate-limit 0.3.0 — OTel via @absolutejs/telemetry', () => {
	test('emits ratelimit.check span on allowed request', async () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const algorithm = gcra({
			burst: 5,
			periodMs: 1000,
			requestsPerPeriod: 100
		});
		const app = new Elysia()
			.use(
				rateLimit({
					algorithm,
					key: () => 'test-key',
					tracerProvider: provider
				})
			)
			.get('/', () => 'ok');
		await app.handle(new Request('http://localhost/'));
		const span = spans.find((s) => s.name === 'ratelimit.check');
		expect(span).toBeDefined();
		expect(span!.attrs[ABS_ATTRS.tenant]).toContain('test-key');
		expect(span!.attrs['ratelimit.allowed']).toBe(true);
		expect(span!.attrs['ratelimit.cost']).toBe(1);
		expect(span!.status?.code).toBe(1);
		expect(span!.ended).toBe(true);
	});

	test('emits ERROR status + retry_after when rate limited', async () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const algorithm = gcra({
			burst: 0,
			periodMs: 60_000,
			requestsPerPeriod: 1
		});
		const app = new Elysia()
			.use(
				rateLimit({
					algorithm,
					key: () => 'k',
					tracerProvider: provider
				})
			)
			.get('/', () => 'ok');
		await app.handle(new Request('http://localhost/')); // allow
		await app.handle(new Request('http://localhost/')); // rate-limited
		const checks = spans.filter((s) => s.name === 'ratelimit.check');
		expect(checks).toHaveLength(2);
		expect(checks[0]!.attrs['ratelimit.allowed']).toBe(true);
		expect(checks[1]!.attrs['ratelimit.allowed']).toBe(false);
		expect(checks[1]!.attrs['ratelimit.retry_after_sec']).toBeDefined();
		expect(checks[1]!.status?.code).toBe(2);
	});

	test('without tracerProvider, plugin still works (noop)', async () => {
		const algorithm = gcra({
			burst: 5,
			periodMs: 1000,
			requestsPerPeriod: 100
		});
		const app = new Elysia()
			.use(rateLimit({ algorithm, key: () => 'k' }))
			.get('/', () => 'ok');
		const res = await app.handle(new Request('http://localhost/'));
		expect(res.status).toBe(200);
	});

	test('cost attribute reflects custom cost', async () => {
		const { provider, spans } = makeCapturingTracerProvider();
		const algorithm = gcra({
			burst: 100,
			periodMs: 1000,
			requestsPerPeriod: 100
		});
		const app = new Elysia()
			.use(
				rateLimit({
					algorithm,
					cost: 5,
					key: () => 'k',
					tracerProvider: provider
				})
			)
			.get('/', () => 'ok');
		await app.handle(new Request('http://localhost/'));
		const span = spans.find((s) => s.name === 'ratelimit.check');
		expect(span!.attrs['ratelimit.cost']).toBe(5);
	});
});
