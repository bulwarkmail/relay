import crypto from 'node:crypto';
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
const MAX_TRACKED_HOSTS = 1000;
const MAX_TRACKED_SUBSCRIPTIONS = 100_000;

export interface Hold {
  reason: 'rate-limit' | 'push-service-backoff' | 'push-service-throttle';
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

// The same host name can serve browsers and native apps (fcm.googleapis.com), under
// different senders and quotas.
export function hostThrottleKey(record: SubscriptionRecord, host: string): string {
  return `${record.kind}:${host}`;
}

// Who a 429 counts for: subscriptions on one endpoint are one device.
function deviceOf(record: SubscriptionRecord): string {
  if (record.kind === 'web') return record.webPush.endpoint;
  if (record.kind === 'up') return record.endpoint;
  return record.kind === 'fcm' ? record.fcmToken : record.deviceToken;
}

export function parseRetryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

class ForwardPolicy {
  private buckets = new Map<string, Bucket>();
  private backoffs = new Map<string, number>();
  private hostThrottles = new Map<string, { devices: Set<string>; windowStart: number; until: number }>();

  /** Whether this push should stay here for now. Takes a token when it goes out. */
  hold(id: string, record: SubscriptionRecord, now = Date.now()): Hold | null {
    const until = this.backoffs.get(id);
    if (until !== undefined) {
      if (until > now) {
        return { reason: 'push-service-backoff', retryAfterSeconds: Math.ceil((until - now) / 1000) };
      }
      this.backoffs.delete(id);
    }
    const host = this.hostThrottles.get(hostThrottleKey(record, pushServiceHost(record)));
    if (host && host.until > now) {
      return { reason: 'push-service-throttle', retryAfterSeconds: Math.ceil((host.until - now) / 1000) };
    }
    // FCM and APNs have their own quotas and the native apps' silent sync to think
    // about; these two are what production saw throttled.
    if (record.kind !== 'web' && record.kind !== 'up') return null;
    return this.takeToken(id, now);
  }

  private takeToken(id: string, now: number): Hold | null {
    const burst = positiveEnv('PUSH_SUBSCRIPTION_BURST', 10);
    const refillMs = positiveEnv('PUSH_SUBSCRIPTION_REFILL_MS', 20_000);
    const bucket = this.buckets.get(id) ?? { tokens: burst, updatedAt: now };
    const tokens = Math.min(burst, bucket.tokens + (now - bucket.updatedAt) / refillMs);
    if (tokens < 1) {
      this.buckets.set(id, { tokens, updatedAt: now });
      return { reason: 'rate-limit', retryAfterSeconds: Math.ceil(((1 - tokens) * refillMs) / 1000) };
    }
    this.buckets.set(id, { tokens: tokens - 1, updatedAt: now });
    return null;
  }

  /** Learns from the service's answer. */
  note(id: string, record: SubscriptionRecord, result: SendResult, now = Date.now()): void {
    const throttled = result.status === 429;
    if (!throttled && result.retryAfterSeconds === undefined) return;
    const seconds = Math.min(result.retryAfterSeconds ?? DEFAULT_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS);
    this.backoffs.set(id, now + seconds * 1000);
    if (!throttled) return;
    const name = hostThrottleKey(record, pushServiceHost(record));
    const host = this.hostThrottles.get(name);
    const current = host && now - host.windowStart < HOST_WINDOW_MS
      ? host
      : { devices: new Set<string>(), windowStart: now, until: host?.until ?? 0 };
    const limit = positiveEnv('PUSH_HOST_THROTTLE_LIMIT', 20);
    if (current.devices.size < limit) current.devices.add(deviceOf(record));
    if (current.devices.size >= limit) {
      current.until = now + Math.min(seconds, MAX_HOST_HOLD_SECONDS) * 1000;
    }
    this.hostThrottles.set(name, current);
    this.prune(now);
  }

  // Hosts are the caller's choice, and records go away without this hearing of it.
  private prune(now: number): void {
    if (this.hostThrottles.size > MAX_TRACKED_HOSTS) {
      for (const [name, host] of this.hostThrottles) {
        if (now - host.windowStart >= HOST_WINDOW_MS && host.until <= now) this.hostThrottles.delete(name);
      }
    }
    if (this.backoffs.size > MAX_TRACKED_SUBSCRIPTIONS) {
      for (const [id, until] of this.backoffs) if (until <= now) this.backoffs.delete(id);
    }
    if (this.buckets.size > MAX_TRACKED_SUBSCRIPTIONS) this.buckets.clear();
  }

  /** The record is gone or points somewhere new: what the old endpoint earned doesn't apply. */
  forget(id: string): void {
    this.backoffs.delete(id);
  }

  /** The record is gone for good. */
  remove(id: string): void {
    this.backoffs.delete(id);
    this.buckets.delete(id);
  }
}

export const forwardPolicy = new ForwardPolicy();
