import type { Change } from '@absolutejs/changelog';

export const change: Change = {
	detail: 'With trustedProxies set and no x-forwarded-for, the IP key fell back to cf-connecting-ip, fly-client-ip, true-client-ip or x-real-ip, which any client can send, so a caller could choose its own rate-limit key. Those headers are no longer read unless one is named as clientIpHeader. trustedProxyCidrs (also on the Elysia plugin) limits forwarded-header trust to connections from the proxies themselves; ipInCidr is exported.',
	kind: 'security',
	summary:
		'Stop trusting CDN client headers by default; add trustedProxyCidrs and clientIpHeader'
};
