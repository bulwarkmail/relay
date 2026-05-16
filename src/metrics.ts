import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

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

export const pushesReceived = new Counter({
  name: 'relay_pushes_received_total',
  help: 'JMAP push bodies received from Stalwart',
  labelNames: ['type'] as const,
  registers: [registry],
});

export const pushesForwarded = new Counter({
  name: 'relay_pushes_forwarded_total',
  help: 'Push forwarding outcomes by transport',
  labelNames: ['result', 'transport'] as const,
  registers: [registry],
});

export const fcmDurationSeconds = new Histogram({
  name: 'relay_fcm_send_duration_seconds',
  help: 'Latency of POST to fcm.googleapis.com',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const webPushDurationSeconds = new Histogram({
  name: 'relay_webpush_send_duration_seconds',
  help: 'Latency of encrypted Web Push delivery',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
