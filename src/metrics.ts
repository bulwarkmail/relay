import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

// /metrics is off unless METRICS_TOKEN (or METRICS_TOKEN_FILE) is set, and
// then wants `Authorization: Bearer <token>`. Read on every scrape, so a new
// token in the file works without a restart.
export function metricsToken(): string | null {
  const direct = process.env.METRICS_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.METRICS_TOKEN_FILE?.trim();
  if (!file) return null;
  try {
    return readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function metricsAuthorized(authorization: string | undefined, token: string): boolean {
  const header = authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length).trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'relay_' });

export const httpRequestsTotal = new Counter({
  name: 'relay_http_requests_total',
  help: 'HTTP requests served by route + status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDurationSeconds = new Histogram({
  name: 'relay_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const subscriptionsRegistered = new Counter({
  name: 'relay_subscriptions_registered_total',
  help: 'Subscription register calls (new or refreshed token), by transport',
  labelNames: ['transport'] as const,
  registers: [registry],
});

export const subscriptionsUnregistered = new Counter({
  name: 'relay_subscriptions_unregistered_total',
  help: 'Subscription deletions, by reason and transport',
  labelNames: ['reason', 'transport'] as const,
  registers: [registry],
});

export const subscriptionsActive = new Gauge({
  name: 'relay_subscriptions_active',
  help: 'Currently stored subscriptions, by transport',
  labelNames: ['transport'] as const,
  registers: [registry],
});

export const storeWriteFailures = new Counter({
  name: 'relay_store_write_failures_total',
  help: 'Store writes that failed. The change is not kept: the request that made it got a 500, or after a forward only a log line',
  registers: [registry],
});

export const pushesReceived = new Counter({
  name: 'relay_pushes_received_total',
  help: 'JMAP push bodies received from Stalwart',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const pushesForwarded = new Counter({
  name: 'relay_pushes_forwarded_total',
  help: 'Push forwarding outcomes by transport and push service HTTP status ("none" = no response)',
  labelNames: ['result', 'transport', 'status'] as const,
  registers: [registry],
});

export const pushesHeld = new Counter({
  name: 'relay_pushes_held_total',
  help: 'Pushes answered with "try again later" without calling the push service, by reason',
  labelNames: ['reason', 'transport'] as const,
  registers: [registry],
});

export const fcmDurationSeconds = new Histogram({
  name: 'relay_fcm_send_duration_seconds',
  help: 'Latency of POST to fcm.googleapis.com',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const apnsDurationSeconds = new Histogram({
  name: 'relay_apns_send_duration_seconds',
  help: 'Latency of POST to api.push.apple.com (or the sandbox)',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const webPushDurationSeconds = new Histogram({
  name: 'relay_webpush_send_duration_seconds',
  help: 'Latency of encrypted Web Push delivery',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const upDurationSeconds = new Histogram({
  name: 'relay_unifiedpush_send_duration_seconds',
  help: 'Latency of delivery to a UnifiedPush distributor endpoint',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
