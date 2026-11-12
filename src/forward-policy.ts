import crypto from 'node:crypto';
import { TokenBuckets } from './client-limit.js';
import { pushServiceHost, type SendResult } from './forward-result.js';
import type { EmailPush, StateChange, SubscriptionRecord } from './types.js';

// How the relay treats the push services. Stalwart sends one push per second per
// subscription while mail keeps coming (its default throttle), and the relay used
// to pass all of them on: 2,664 Web Push 429s from one mail server in two days.
//
// There is no queue here. A held push answers the mail server with a non-2xx, and
// Stalwart keeps what it has, merges what comes next into it and tries again a
// minute later (3 attempts by default), so a flood turns into one push a minute
// and nothing has to survive a relay restart.

export type Urgency = 'very-low' | 'low' | 'normal' | 'high';

export interface DeliveryOptions {
  urgency: Urgency;
  topic?: string;
}

const URGENCIES: readonly string[] = ['very-low', 'low', 'normal', 'high'];

export function deliveryOptions(
  subscriptionId: string,
  body: StateChange | EmailPush,
  requestedUrgency: string | string[] | undefined,
): DeliveryOptions {
  if (body['@type'] === 'EmailPush') {
    // The client chose this in its emailPush config and the server passes it on.
    const urgency = typeof requestedUrgency === 'string' && URGENCIES.includes(requestedUrgency)
      ? (requestedUrgency as Urgency)
      : 'high';
    // Each one names other messages: a replacement would lose the earlier ones.
    return { urgency };
  }
  const changed = body.changed && typeof body.changed === 'object' ? body.changed : {};
  const accounts = Object.keys(changed);
  const newMail = accounts.some((account) => {
    const types = changed[account];
    return !!types && typeof types === 'object' && 'EmailDelivery' in types;
  });
  // Stalwart marks every state change "normal". New mail is what the user waits
  // for, on a phone that may be asleep. A server without EmailDelivery says it as
  // Email, which also covers everything else. The rest is a hint for later.
  const anyEmail = accounts.some((account) => {
    const types = changed[account];
    return !!types && typeof types === 'object' && 'Email' in types;
  });
  const urgency: Urgency = newMail ? 'high' : anyEmail ? 'normal' : 'low';
  // One account's new-mail pings say the same thing, so a device that was offline
  // only needs the last (RFC 8030 replacement). Anything else must not replace one,
  // and two accounts in one push share no such topic: that could lose one of them.
  if (!newMail || accounts.length !== 1) return { urgency };
  const topic = crypto
    .createHash('sha256')
    .update(`${subscriptionId}\0${accounts[0]}`)
    .digest('base64url')
    .slice(0, 32);
  return { urgency, topic };
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEFAULT_BACKOFF_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;
const HOST_WINDOW_MS = 60_000;
// However long one answer asks for: this stops every subscription on the service,
// and the mail server gives up on a held push after two minutes.
const MAX_HOST_HOLD_SECONDS = 120;
// What has run out goes this often; nothing that is still running.
const PRUNE_INTERVAL_MS = 60_000;
// Pushes the relay forwards to one endpoint (or token) at once, then one more
// every ENDPOINT_REFILL_MS, whatever number of ids share it and however its path
// is written: an endpoint gets no more for having more ids. Ten accounts in one
// browser, each at the sustained rate one id gets, still fit. Endpoints that
// differ in their query have a budget each: WNS (Edge) keeps the device there.
const ENDPOINT_BURST = 30;
const ENDPOINT_REFILL_MS = 2000;
// A host is held for everyone only when the devices it throttled were
// registered from at least this many client addresses, where the relay can tell
// addresses apart: a service that throttles the relay as a whole throttles the
// devices of many users, and devices registered from one address are held one by
// one instead.
const HOST_HOLD_MIN_ADDRESSES = 5;
// Endpoints in backoff at once. Past it the one that went into backoff first is
// forgotten: endpoints are chosen at registration, and one id can go through many.
const MAX_BACKOFFS = 10_000;

export interface Hold {
  reason: 'rate-limit' | 'endpoint-rate-limit' | 'push-service-backoff' | 'push-service-throttle';
  retryAfterSeconds: number;
}

// The same host name can serve browsers and native apps (fcm.googleapis.com), under
// different senders and quotas.
export function hostThrottleKey(record: SubscriptionRecord, host: string): string {
  return `${record.kind}:${host}`;
}

// Characters that are the same written as themselves or as %XX (RFC 3986,
// 2.3). Any other %XX stands for what it encodes: `%2F` is a slash inside a
// segment, not a separator, and stays.
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

function samePercentEncoding(text: string): string {
  return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

// RFC 3986, 5.2.4, for a path that starts with a slash.
function withoutDotSegments(pathname: string): string {
  const segments = pathname.split('/').slice(1);
  const out: string[] = [];
  segments.forEach((segment, i) => {
    if (segment === '..') out.pop();
    if (segment !== '.' && segment !== '..') out.push(segment);
    else if (i === segments.length - 1) out.push('');
  });
  return `/${out.join('/')}`;
}

/**
 * What an endpoint counts as, the same for every way of writing it (RFC 3986,
 * 6.2.2): scheme and host in lower case, without the default port or a trailing
 * dot on the host, unreserved characters as themselves and the hex digits of any
 * other %XX in upper case, no dot segments, no fragment (it never reaches the
 * service), and the query only when `withQuery`. The endpoint the relay stores
 * and calls stays as the client registered it.
 */
function endpointKey(endpoint: string, withQuery: boolean): string {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname;
    const port = url.port ? `:${url.port}` : '';
    const query = withQuery && url.search ? samePercentEncoding(url.search) : '';
    return `${url.protocol}//${host}${port}${withoutDotSegments(samePercentEncoding(url.pathname))}${query}`;
  } catch {
    return endpoint;
  }
}

// What a push service throttles: the endpoint, or the token. Subscriptions on one
// are one device, however the endpoint is written.
function deviceOf(record: SubscriptionRecord): string {
  if (record.kind === 'fcm') return `fcm:${record.fcmToken}`;
  if (record.kind === 'apns') return `apns:${record.deviceToken}`;
  return endpointKey(record.kind === 'web' ? record.webPush.endpoint : record.endpoint, true);
}

// What counts as one device toward holding a whole host: the endpoint without its
// query either, since any number of queries can be put on one endpoint. Push
// services that keep the device in the query (WNS) then count as one device per
// host and path, and their endpoints are held one by one.
function hostDeviceOf(record: SubscriptionRecord): string {
  if (record.kind === 'fcm' || record.kind === 'apns') return deviceOf(record);
  return endpointKey(record.kind === 'web' ? record.webPush.endpoint : record.endpoint, false);
}

// The host a hold is kept for, written one way.
function holdKey(record: SubscriptionRecord): string {
  const host = pushServiceHost(record);
  return hostThrottleKey(record, host.endsWith('.') ? host.slice(0, -1) : host);
}

export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

class ForwardPolicy {
  // Pushes per subscription id, for every transport.
  private buckets = new TokenBuckets(
    () => positiveEnv('PUSH_SUBSCRIPTION_BURST', 10),
    () => positiveEnv('PUSH_SUBSCRIPTION_REFILL_MS', 20_000),
  );
  // Pushes per endpoint or token, whichever ids it is shared by.
  private endpointBuckets = new TokenBuckets(() => ENDPOINT_BURST, () => ENDPOINT_REFILL_MS);
  // By device: every id on an endpoint waits, and a new registration of the same
  // endpoint doesn't end what the service asked for.
  private backoffs = new Map<string, number>();
  // Per host: the devices throttled in the window, with the client address each
  // was registered from (null where the relay can't tell).
  private hostThrottles = new Map<string, { devices: Map<string, string | null>; windowStart: number; until: number }>();

  /** Whether this push should stay here for now. Takes a token of each budget when it goes out. */
  hold(id: string, record: SubscriptionRecord, now = Date.now()): Hold | null {
    const device = deviceOf(record);
    const until = this.backoffs.get(device);
    if (until !== undefined && until > now) {
      return { reason: 'push-service-backoff', retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    const host = this.hostThrottles.get(holdKey(record));
    if (host && host.until > now) {
      return { reason: 'push-service-throttle', retryAfterSeconds: Math.ceil((host.until - now) / 1000) };
    }
    const forId = this.buckets.wait(id, now);
    if (forId !== null) return { reason: 'rate-limit', retryAfterSeconds: forId };
    const forEndpoint = this.endpointBuckets.wait(device, now);
    if (forEndpoint !== null) return { reason: 'endpoint-rate-limit', retryAfterSeconds: forEndpoint };
    this.buckets.take(id, now);
    this.endpointBuckets.take(device, now);
    return null;
  }

  /**
   * Learns from the service's answer. `address` is the client address the record
   * was registered from, null when the relay can't tell.
   */
  note(record: SubscriptionRecord, result: SendResult, address: string | null, now = Date.now()): void {
    const throttled = result.status === 429;
    if (!throttled && result.retryAfterSeconds === undefined) return;
    const seconds = Math.min(result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS);
    const device = deviceOf(record);
    this.backoffs.delete(device);
    this.backoffs.set(device, now + seconds * 1000);
    if (this.backoffs.size > MAX_BACKOFFS) this.backoffs.delete(this.backoffs.keys().next().value!);
    // A record that never got a push through says nothing about the service's
    // quota for everybody else, and anyone can make one.
    if (!throttled || record.lastPushAt == null) return;
    const name = holdKey(record);
    const host = this.hostThrottles.get(name);
    const current = host && now - host.windowStart < HOST_WINDOW_MS
      ? host
      : { devices: new Map<string, string | null>(), windowStart: now, until: host?.until ?? 0 };
    const limit = positiveEnv('PUSH_HOST_THROTTLE_LIMIT', 20);
    if (current.devices.size < limit) current.devices.set(hostDeviceOf(record), address);
    if (current.devices.size >= limit && addressesOf(current.devices) >= Math.min(HOST_HOLD_MIN_ADDRESSES, limit)) {
      current.until = now + Math.min(seconds, MAX_HOST_HOLD_SECONDS) * 1000;
    }
    this.hostThrottles.set(name, current);
  }

  // Hosts and endpoints are the caller's choice, and records go away without
  // this hearing of it. Only what has run out goes.
  prune(now = Date.now()): void {
    for (const [name, host] of this.hostThrottles) {
      if (now - host.windowStart >= HOST_WINDOW_MS && host.until <= now) this.hostThrottles.delete(name);
    }
    for (const [device, until] of this.backoffs) if (until <= now) this.backoffs.delete(device);
    this.buckets.prune(now);
    this.endpointBuckets.prune(now);
  }

  /** The record is gone for good. */
  remove(id: string): void {
    this.buckets.delete(id);
  }
}

// Distinct client addresses behind these devices. A device whose address the
// relay couldn't tell counts as one address of its own.
function addressesOf(devices: Map<string, string | null>): number {
  const known = new Set<string>();
  let unknown = 0;
  for (const address of devices.values()) {
    if (address === null) unknown++;
    else known.add(address);
  }
  return known.size + unknown;
}

export const forwardPolicy = new ForwardPolicy();
setInterval(() => forwardPolicy.prune(), PRUNE_INTERVAL_MS).unref();
