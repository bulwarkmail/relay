import type http from 'node:http';
import net from 'node:net';
import { logger } from './logger.js';

// How many registrations one client address may make: PUSH_REGISTER_BURST at
// once, one more every PUSH_REGISTER_REFILL_MS. A browser registers once per
// account and page load, an app once per account and start.
//
// The address is the socket's, or behind TRUST_PROXY proxies the one the
// nearest of them saw (X-Forwarded-For, counted from the right: each proxy
// appends what it saw, and whatever the client wrote stands in front). A relay
// that only sees a proxy's private address can't tell its clients apart; a
// budget for that address would be one budget for everybody, so there is none.

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** TRUST_PROXY: how many proxies stand in front of the relay. */
export function trustedProxies(): number {
  const value = Number(process.env.TRUST_PROXY);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

// Loopback, private, shared and link-local: a peer here is a proxy or the host.
const proxyNetworks = new net.BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  proxyNetworks.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  proxyNetworks.addSubnet(network, prefix, 'ipv6');
}

function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const middle = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...middle, ...right].map((group) => parseInt(group, 16));
}

interface Address {
  address: string;
  family: 'ipv4' | 'ipv6';
}

/** The address in a header entry or a socket: without a port, brackets or a zone, IPv4 written as IPv6 as IPv4. */
function parseAddress(raw: string): Address | null {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(':'));
  value = value.replace(/%[^%]*$/, '');
  const family = net.isIP(value);
  if (family === 4) return { address: value, family: 'ipv4' };
  if (family !== 6) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped) return { address: mapped[1], family: 'ipv4' };
  return { address: value, family: 'ipv6' };
}

/** What the limit counts by: IPv4 by address, IPv6 by its /64, which one client usually holds whole. */
function keyOf({ address, family }: Address): string {
  if (family === 'ipv4') return address;
  return `${ipv6Groups(address).slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** The key an address counts under, or null when it is none. */
export function addressKey(raw: string): string | null {
  const parsed = parseAddress(raw);
  return parsed ? keyOf(parsed) : null;
}

// Every entry of a header that names no address shares this one budget.
const UNREADABLE = 'unreadable-forwarded-for';

/** Whose budget a request spends: an address key, or null when the relay can't tell. */
export function clientKey(req: http.IncomingMessage, proxies = trustedProxies()): string | null {
  const header = req.headers['x-forwarded-for'];
  if (proxies > 0 && header !== undefined) {
    const entries = (Array.isArray(header) ? header.join(',') : header).split(',');
    // Fewer entries than proxies: a proxy added none, and none of these is the client's.
    if (entries.length >= proxies) return addressKey(entries[entries.length - proxies]) ?? UNREADABLE;
  }
  const peer = parseAddress(req.socket.remoteAddress ?? '');
  if (!peer || proxyNetworks.check(peer.address, peer.family)) return null;
  return keyOf(peer);
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token buckets by key. A bucket that has filled up again is the same as none, and goes. */
export class TokenBuckets {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly burst: () => number,
    private readonly refillMs: () => number,
  ) {}

  /** The seconds until there is a token, or null when there is one now. Takes none. */
  wait(key: string, now = Date.now()): number | null {
    const burst = this.burst();
    const refillMs = this.refillMs();
    const bucket = this.buckets.get(key);
    const tokens = bucket ? Math.min(burst, bucket.tokens + (now - bucket.updatedAt) / refillMs) : burst;
    return tokens < 1 ? Math.max(1, Math.ceil(((1 - tokens) * refillMs) / 1000)) : null;
  }

  /** Takes a token. Null when there was one, otherwise the seconds until there is. */
  take(key: string, now = Date.now()): number | null {
    const burst = this.burst();
    const refillMs = this.refillMs();
    const bucket = this.buckets.get(key);
    const tokens = bucket ? Math.min(burst, bucket.tokens + (now - bucket.updatedAt) / refillMs) : burst;
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return Math.max(1, Math.ceil(((1 - tokens) * refillMs) / 1000));
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return null;
  }

  /** Drops the buckets that are full again. Budgets in use stay as they are. */
  prune(now = Date.now()): void {
    const burst = this.burst();
    const refillMs = this.refillMs();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) / refillMs >= burst) this.buckets.delete(key);
    }
  }

  delete(key: string): void {
    this.buckets.delete(key);
  }
}

const registrations = new TokenBuckets(
  () => positiveEnv('PUSH_REGISTER_BURST', 60),
  () => positiveEnv('PUSH_REGISTER_REFILL_MS', 2000),
);
setInterval(() => registrations.prune(), 60_000).unref();

let warnedShared = false;

/** Spends one registration of the caller's address. Null when it may go ahead, otherwise the seconds to wait. */
export function takeRegistration(req: http.IncomingMessage): number | null {
  const key = clientKey(req);
  if (key === null) {
    if (!warnedShared) {
      warnedShared = true;
      logger.warn('relay: registrations come from a proxy address, so there is no limit per client address; set TRUST_PROXY to the number of proxies in front of the relay', { trustProxy: trustedProxies() });
    }
    return null;
  }
  return registrations.take(key);
}
