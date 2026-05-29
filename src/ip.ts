/**
 * IP extraction with X-Forwarded-For trust modes and IPv6 prefix grouping.
 *
 *   - `trustedProxies: 0` — ignore XFF entirely; use the connection IP only.
 *   - `trustedProxies: N` — take the N-th-from-end entry from XFF. This is
 *     the "the request came through N proxies I trust; the (N+1)-th from
 *     the right is the originator" semantics. Anything before that is
 *     attacker-controlled and ignored.
 *
 * IPv6: by default group by /64 — `2001:db8::1` and `2001:db8::2` are the
 * same user's allocation per IETF RIR convention. Per-/128 grouping is the
 * naive choice and gives every device its own quota; per-/64 is the
 * rate-limit convention. Configurable via `ipv6Prefix`.
 */

export type IpExtractOptions = {
	/** Connection-level remote address (from the listener). */
	connectionIp: string | null;
	/** Headers from the request. */
	headers: Headers;
	/**
	 * Number of trusted proxies in front of this app. Default `0` (don't
	 * trust XFF). Set to `1` for a single-CDN deployment, `2` for CDN +
	 * load balancer, etc.
	 */
	trustedProxies?: number;
	/**
	 * Group IPv6 addresses by this prefix length (bits). Default `64`. Set
	 * `128` to disable grouping. Has no effect on IPv4.
	 */
	ipv6Prefix?: number;
};

/**
 * Pull the requester IP from the request, honoring trust mode. Returns a
 * normalized string — IPv6 addresses are reduced to the configured prefix
 * (default /64) for stable grouping. Returns `'unknown'` only if no IP
 * could be determined at all (rare; some test harnesses).
 */
export const extractIp = (options: IpExtractOptions): string => {
	const trust = options.trustedProxies ?? 0;
	const prefix = options.ipv6Prefix ?? 64;

	let candidate: string | null = null;
	if (trust > 0) {
		const xff = options.headers.get('x-forwarded-for');
		if (xff !== null) {
			const parts = xff.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
			// The originator is the leftmost — but we only trust the N rightmost,
			// because anything past that point is supplied by an untrusted client.
			// Take parts[parts.length - trust] which is the boundary between
			// trusted and untrusted.
			const index = parts.length - trust;
			if (index >= 0 && index < parts.length) {
				candidate = parts[index] ?? null;
			} else if (parts.length > 0) {
				// XFF had fewer hops than trust; the leftmost is the originator.
				candidate = parts[0] ?? null;
			}
		}
		// Some CDNs use a single-value header instead (cf-connecting-ip,
		// fly-client-ip, true-client-ip). Honor any of them; first non-empty wins.
		if (candidate === null) {
			for (const name of ['cf-connecting-ip', 'fly-client-ip', 'true-client-ip', 'x-real-ip']) {
				const value = options.headers.get(name);
				if (value !== null && value.length > 0) { candidate = value.trim(); break; }
			}
		}
	}

	const ip = candidate ?? options.connectionIp ?? 'unknown';
	return normalizeIp(ip, prefix);
};

/**
 * Normalize a host string: strip ports, brackets, zone ids; reduce IPv6 to
 * the requested prefix; lowercase. Returns the input if it doesn't parse as
 * a recognizable IP.
 */
export const normalizeIp = (input: string, ipv6Prefix = 64): string => {
	let cleaned = input.trim();
	if (cleaned.length === 0) return 'unknown';

	// Strip IPv6 brackets + port.
	if (cleaned.startsWith('[')) {
		const close = cleaned.indexOf(']');
		if (close > 0) cleaned = cleaned.slice(1, close);
	} else {
		// IPv4 with port: a.b.c.d:port (only one colon).
		const colon = cleaned.indexOf(':');
		const otherColon = cleaned.indexOf(':', colon + 1);
		if (colon > 0 && otherColon < 0) cleaned = cleaned.slice(0, colon);
	}

	// Strip zone id (fe80::1%eth0).
	const percent = cleaned.indexOf('%');
	if (percent > 0) cleaned = cleaned.slice(0, percent);

	cleaned = cleaned.toLowerCase();

	// IPv4-mapped IPv6 (::ffff:1.2.3.4) → treat as the embedded IPv4.
	if (cleaned.startsWith('::ffff:')) {
		const v4 = cleaned.slice('::ffff:'.length);
		if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4;
	}

	if (cleaned.includes(':')) {
		// IPv6.
		return applyIpv6Prefix(cleaned, ipv6Prefix);
	}
	return cleaned;
};

const applyIpv6Prefix = (input: string, prefix: number): string => {
	const bits = Math.max(0, Math.min(128, prefix));
	if (bits === 128) return input;
	const expanded = expandIpv6(input);
	if (expanded === null) return input;
	const hextets = expanded.split(':').map((h) => parseInt(h, 16));
	if (hextets.length !== 8) return input;
	const out = new Array<number>(8).fill(0);
	for (let i = 0; i < 8; i++) {
		const bitsLeft = bits - i * 16;
		if (bitsLeft >= 16) {
			out[i] = hextets[i] ?? 0;
		} else if (bitsLeft <= 0) {
			out[i] = 0;
		} else {
			const mask = (0xffff << (16 - bitsLeft)) & 0xffff;
			out[i] = (hextets[i] ?? 0) & mask;
		}
	}
	return out.map((h) => h.toString(16)).join(':') + `/${bits}`;
};

const expandIpv6 = (input: string): string | null => {
	const dbl = input.split('::');
	if (dbl.length > 2) return null;
	const left = dbl[0] && dbl[0].length > 0 ? dbl[0].split(':') : [];
	const right = dbl.length === 2 && dbl[1] && dbl[1].length > 0 ? dbl[1].split(':') : [];
	const missing = 8 - left.length - right.length;
	if (missing < 0) return null;
	const middle = new Array<string>(missing).fill('0');
	const parts = [...left, ...middle, ...right];
	if (parts.length !== 8) return null;
	return parts.map((part) => {
		if (!/^[0-9a-f]{0,4}$/.test(part)) return null;
		return part.padStart(4, '0');
	}).join(':');
};
