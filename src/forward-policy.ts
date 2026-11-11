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

export interface Hold {
  reason: 'rate-limit' | 'push-service-backoff' | 'push-service-throttle';
  retryAfterSeconds: number;
}

// The same host name can serve browsers and native apps (fcm.googleapis.com), under
// different senders and quotas.
export function hostThrottleKey(record: SubscriptionRecord, host: string): string {
  return `${record.kind}:${host}`;
}

// What a push service throttles: the endpoint, or the token. Subscriptions on one
// are one device, and a fragment is no part of it (it never reaches the service).
function deviceOf(record: SubscriptionRecord): string {
  if (record.kind === 'fcm') return `fcm:${record.fcmToken}`;
  if (record.kind === 'apns') return `apns:${record.deviceToken}`;
  const endpoint = record.kind === 'web' ? record.webPush.endpoint : record.endpoint;
  const fragment = endpoint.indexOf('#');
  return fragment === -1 ? endpoint : endpoint.slice(0, fragment);
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
  // By device: every id on an endpoint waits, and a new registration of the same
  // endpoint doesn't end what the service asked for.
  private backoffs = new Map<string, number>();
  private hostThrottles = new Map<string, { devices: Set<string>; windowStart: number; until: number }>();

  /** Whether this push should stay here for now. Takes a token when it goes out. */
  hold(id: string, record: SubscriptionRecord, now = Date.now()): Hold | null {
    const until = this.backoffs.get(deviceOf(record));
    if (until !== undefined && until > now) {
      return { reason: 'push-service-backoff', retryAfterSeconds: Math.ceil((until - now) / 1000) };
    }
    const host = this.hostThrottles.get(hostThrottleKey(record, pushServiceHost(record)));
    if (host && host.until > now) {
      return { reason: 'push-service-throttle', retryAfterSeconds: Math.ceil((host.until - now) / 1000) };
    }
    const wait = this.buckets.take(id, now);
    return wait === null ? null : { reason: 'rate-limit', retryAfterSeconds: wait };
  }

  /** Learns from the service's answer. */
  note(record: SubscriptionRecord, result: SendResult, now = Date.now()): void {
    const throttled = result.status === 429;
    if (!throttled && result.retryAfterSeconds === undefined) return;
    const seconds = Math.min(result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS);
    const device = deviceOf(record);
    this.backoffs.set(device, now + seconds * 1000);
    // A record that never got a push through says nothing about the service's
    // quota for everybody else, and anyone can make one.
    if (!throttled || record.lastPushAt == null) return;
    const name = hostThrottleKey(record, pushServiceHost(record));
    const host = this.hostThrottles.get(name);
    const current = host && now - host.windowStart < HOST_WINDOW_MS
      ? host
      : { devices: new Set<string>(), windowStart: now, until: host?.until ?? 0 };
    const limit = positiveEnv('PUSH_HOST_THROTTLE_LIMIT', 20);
    if (current.devices.size < limit) current.devices.add(device);
    if (current.devices.size >= limit) {
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
  }

  /** The record is gone for good. */
  remove(id: string): void {
    this.buckets.delete(id);
  }
}

export const forwardPolicy = new ForwardPolicy();
setInterval(() => forwardPolicy.prune(), PRUNE_INTERVAL_MS).unref();
