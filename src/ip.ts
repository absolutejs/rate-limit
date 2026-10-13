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
	 * Addresses (CIDRs) the trusted proxies connect from. When set, forwarded
	 * headers are read only for a connection from one of them; anything else
	 * is keyed by its own address, so a client that reaches the app directly
	 * cannot choose its key. Leave unset only when the network already
	 * guarantees that every connection comes from the proxies.
	 */
	trustedProxyCidrs?: readonly string[];
	/**
	 * A single-value client-address header a trusted CDN sets (for example
	 * `cf-connecting-ip`), used instead of `x-forwarded-for`. Any client can
	 * send such a header, so it is read only when named here, and only for a
	 * trusted proxy's connection.
	 */
	clientIpHeader?: string;
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
	const fromTrustedProxy =
		trust > 0 &&
		(options.trustedProxyCidrs === undefined ||
			(options.connectionIp !== null &&
				options.trustedProxyCidrs.some((cidr) =>
					ipInCidr(options.connectionIp as string, cidr),
				)));
	if (fromTrustedProxy && options.clientIpHeader) {
		const value = options.headers.get(options.clientIpHeader)?.trim();
		candidate = value && value.length > 0 ? value : null;
	} else if (fromTrustedProxy) {
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
		// CDN single-value headers (cf-connecting-ip, true-client-ip, …) are
		// not a fallback: any client can send one. Name it as clientIpHeader.
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

const ipv4ToBigInt = (ip: string): bigint | null => {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let value = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const octet = Number(part);
		if (octet > 255) return null;
		value = (value << 8n) | BigInt(octet);
	}

	return value;
};

const ipv6ToBigInt = (ip: string): bigint | null => {
	const halves = ip.toLowerCase().split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	let value = 0n;
	for (const group of groups) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
		value = (value << 16n) | BigInt(parseInt(group, 16));
	}

	return value;
};

/** Whether `ip` (IPv4 or IPv6, an IPv4-mapped IPv6 counts as IPv4) is inside `cidr`. */
export const ipInCidr = (ip: string, cidr: string): boolean => {
	const [network, bitsText] = cidr.trim().split('/');
	if (!network) return false;
	const address = ip.trim().replace(/^::ffff:(?=\d+\.)/i, '');
	const v4 = ipv4ToBigInt(address);
	const networkV4 = ipv4ToBigInt(network);
	const [value, base, width] =
		v4 !== null && networkV4 !== null
			? [v4, networkV4, 32]
			: [ipv6ToBigInt(address), ipv6ToBigInt(network), 128];
	if (value === null || base === null) return false;
	const bits = bitsText === undefined ? width : Number(bitsText);
	if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
	const shift = BigInt(width - bits);

	return value >> shift === base >> shift;
};
