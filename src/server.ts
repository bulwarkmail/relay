import http from 'node:http';
import { URL } from 'node:url';
import { logger } from './logger.js';
import { subscriptionStore } from './store.js';
import { sendFcmPush } from './fcm.js';
import { getApnsConfig, sendApnsPush } from './apns.js';
import { getVapidPublicKey, sendWebPush } from './webpush.js';
import { sendUnifiedPush } from './unifiedpush.js';
import { isForwardableBody, toForwardPayload } from './payload.js';
import {
  classifyForward,
  failureReason,
  pushServiceHost,
  statusLabel,
  type ForwardOutcome,
  type SendResult,
} from './forward-result.js';
import {
  isValidApnsEnvironment,
  isValidApnsToken,
  isValidFcmToken,
  isValidSubscriptionId,
  isValidUnifiedPushEndpoint,
  isValidUnifiedPushKeys,
  isValidWebPushSubscription,
} from './validation.js';
import type {
  ApnsSubscriptionRecord,
  FcmSubscriptionRecord,
  ForwardPayload,
  JmapPushBody,
  SubscriptionRecord,
  UnifiedPushSubscriptionRecord,
  WebSubscriptionRecord,
} from './types.js';
import {
  registry,
  httpRequestsTotal,
  httpDurationSeconds,
  subscriptionsRegistered,
  subscriptionsUnregistered,
  subscriptionsActive,
  pushesReceived,
  pushesForwarded,
  fcmDurationSeconds,
  apnsDurationSeconds,
  webPushDurationSeconds,
  upDurationSeconds,
} from './metrics.js';

const PORT = Number(process.env.PORT ?? 3003);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024;
const REPO_URL = 'https://github.com/bulwarkmail/relay';

// How long after registration we still report a subscription as "active" even
// though it has never forwarded a push. A freshly-created subscription hasn't
// received a StateChange yet (the account may simply have no new mail during
// setup), so without this grace a client racing setup on another device could
// see the in-progress one as dead and reap it. 10 minutes comfortably covers
// the JMAP verify window plus slack.
const ACTIVE_GRACE_MS = 10 * 60 * 1000;

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bulwark Push Relay</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Bulwark Push Relay</h1>
<p>When your mail server has something new, this pings your phone. That's the whole job.</p>
<p>It doesn't see the mail. Not the subject, not the sender, not a byte of the body. Just a ping and a push token.</p>
<p>Source: <a href="${REPO_URL}">${REPO_URL}</a></p>
</body>
</html>
`;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

// The relay is meant to be reachable from any Bulwark deployment's browser
// frontend, so we serve permissive CORS. There are no cookies or credentials
// in any request, so `*` here is safe - opaque subscription ids and FCM
// tokens are the only secrets and clients post them as request bodies.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function applyCors(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!req.headers.origin) return;
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.setHeader(k, v);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function handleRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = (await readJson(req)) as
    | { subscriptionId?: unknown; fcmToken?: unknown; accountLabel?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, fcmToken, accountLabel } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidFcmToken(fcmToken)) {
    return sendJson(res, 400, { error: 'Invalid fcmToken' });
  }

  const existing = await subscriptionStore.get(subscriptionId);
  const record: FcmSubscriptionRecord = {
    kind: 'fcm',
    fcmToken,
    // Always start fresh: a stale verificationCode left over from a previous
    // (now-expired) JMAP subscription would be returned by /verify polling
    // before Stalwart's new PushVerification arrives, and the client would
    // verify with the wrong code. Stalwart re-sends PushVerification on
    // every fresh subscription, so dropping the old code is safe - the warm
    // path (existing JMAP sub still alive) skips polling entirely.
    verificationCode: null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPushAt: existing?.lastPushAt ?? null,
    accountLabel:
      typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
  };
  await subscriptionStore.put(subscriptionId, record);
  subscriptionsRegistered.inc({ transport: 'fcm' });
  await refreshActiveGauge();
  return sendJson(res, 200, { ok: true });
}

// The iOS app. Refused up front when the relay has no APNs key, as Web Push
// is without VAPID keys: the record would be accepted but every push fail.
async function handleRegisterApns(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!(await getApnsConfig())) {
    return sendJson(res, 503, { error: 'APNs not configured' });
  }
  const body = (await readJson(req)) as
    | { subscriptionId?: unknown; deviceToken?: unknown; environment?: unknown; accountLabel?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, deviceToken, environment, accountLabel } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidApnsToken(deviceToken)) {
    return sendJson(res, 400, { error: 'Invalid deviceToken' });
  }
  if (!isValidApnsEnvironment(environment)) {
    return sendJson(res, 400, { error: 'Invalid environment' });
  }

  const existing = await subscriptionStore.get(subscriptionId);
  const record: ApnsSubscriptionRecord = {
    kind: 'apns',
    deviceToken: deviceToken.toLowerCase(),
    environment,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPushAt: existing?.lastPushAt ?? null,
    accountLabel:
      typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
  };
  await subscriptionStore.put(subscriptionId, record);
  subscriptionsRegistered.inc({ transport: 'apns' });
  await refreshActiveGauge();
  return sendJson(res, 200, { ok: true });
}

async function handleRegisterWeb(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Refuse the registration up front if the operator hasn't configured VAPID
  // keys - we'd accept the record but every push would fail.
  if (!getVapidPublicKey()) {
    return sendJson(res, 503, { error: 'Web Push not configured' });
  }
  const body = (await readJson(req)) as
    | {
        subscriptionId?: unknown;
        subscription?: unknown;
        accountLabel?: unknown;
      }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, subscription, accountLabel } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidWebPushSubscription(subscription)) {
    return sendJson(res, 400, { error: 'Invalid subscription' });
  }

  const existing = await subscriptionStore.get(subscriptionId);
  const record: WebSubscriptionRecord = {
    kind: 'web',
    webPush: subscription,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPushAt: existing?.lastPushAt ?? null,
    accountLabel:
      typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
  };
  await subscriptionStore.put(subscriptionId, record);
  subscriptionsRegistered.inc({ transport: 'web' });
  await refreshActiveGauge();
  return sendJson(res, 200, { ok: true });
}

// UnifiedPush (mobile app without Google Play services). No VAPID gate like
// the Web Push route: distributors accept pushes without VAPID, and legacy
// ones without keys get a plain POST anyway.
async function handleRegisterUnifiedPush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = (await readJson(req)) as
    | {
        subscriptionId?: unknown;
        endpoint?: unknown;
        keys?: unknown;
        accountLabel?: unknown;
      }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, endpoint, keys, accountLabel } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidUnifiedPushEndpoint(endpoint)) {
    return sendJson(res, 400, { error: 'Invalid endpoint' });
  }
  if (keys != null && !isValidUnifiedPushKeys(keys)) {
    return sendJson(res, 400, { error: 'Invalid keys' });
  }

  const existing = await subscriptionStore.get(subscriptionId);
  const record: UnifiedPushSubscriptionRecord = {
    kind: 'up',
    endpoint,
    keys: keys ?? null,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPushAt: existing?.lastPushAt ?? null,
    accountLabel:
      typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
  };
  await subscriptionStore.put(subscriptionId, record);
  subscriptionsRegistered.inc({ transport: 'up' });
  await refreshActiveGauge();
  return sendJson(res, 200, { ok: true });
}

async function handleUnregister(
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  // Look up the record before deleting so we can attribute the unregister to
  // the right transport in metrics.
  const existing = await subscriptionStore.get(id);
  await subscriptionStore.delete(id);
  subscriptionsUnregistered.inc({
    reason: 'client',
    transport: existing?.kind ?? 'unknown',
  });
  await refreshActiveGauge();
  return sendJson(res, 200, { ok: true });
}

async function handleVerifyPoll(
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  const record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }
  return sendJson(res, 200, { verificationCode: record.verificationCode ?? null });
}

// Liveness probe used by clients during setup to decide whether a leftover JMAP
// PushSubscription on the account belongs to a still-active device (keep it) or
// is dead debris starving the new one's verification (safe to reap). Stalwart
// hides a subscription's verified state and URL from clients, so the relay -
// which sees the actual push traffic - is the only place that can tell them
// apart. A verified, working subscription receives StateChange pushes and so
// has a non-null lastPushAt; one that never verified never receives a push.
// 404 (unknown id) deliberately means "not on this relay" so callers leave it
// alone rather than reaping another relay's or a non-Bulwark client's record.
async function handleActivePoll(
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  const record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }
  const active =
    record.lastPushAt != null || Date.now() - record.createdAt < ACTIVE_GRACE_MS;
  return sendJson(res, 200, { active });
}

async function handleJmap(
  req: http.IncomingMessage,
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }

  const record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }

  const body = (await readJson(req)) as JmapPushBody | null | undefined;
  if (!body || typeof body !== 'object' || typeof body['@type'] !== 'string') {
    return sendJson(res, 400, { error: 'Invalid JMAP push body' });
  }

  if (body['@type'] === 'PushVerification') {
    pushesReceived.inc({ type: 'PushVerification' });
    record.verificationCode = body.verificationCode;
    await subscriptionStore.put(id, record);
    return sendJson(res, 200, { ok: true });
  }

  // StateChange: the classic per-type ping. EmailPush: the server applied the
  // client's delivery filter (draft-ietf-jmap-emailpush) and lists the
  // messages that passed - both become the same content-blind device payload.
  if (isForwardableBody(body)) {
    pushesReceived.inc({ type: body['@type'] });
    let result: SendResult;
    try {
      result = await dispatch(record, toForwardPayload(body, record.accountLabel));
    } catch (error) {
      // FCM token minting and sending throw on network errors. Count and log
      // them like any other failed forward, then answer 500 as before so the
      // JMAP server may retry.
      const failed = { ok: false, status: 0, unregistered: false, reason: failureReason(error) };
      pushesForwarded.inc({ result: 'fail', transport: record.kind, status: 'none' });
      logForwardFailure(id, record, 'fail', failed);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
    const outcome = classifyForward(result);
    pushesForwarded.inc({
      result: outcome,
      transport: record.kind,
      status: statusLabel(result.status),
    });
    if (outcome !== 'ok') logForwardFailure(id, record, outcome, result);
    record.lastPushAt = Date.now();
    await subscriptionStore.put(id, record);
    if (result.unregistered) {
      await subscriptionStore.delete(id);
      const reason =
        record.kind === 'fcm'
          ? 'fcm-unregistered'
          : record.kind === 'apns'
            ? 'apns-unregistered'
            : record.kind === 'up'
              ? 'unifiedpush-gone'
              : 'webpush-gone';
      subscriptionsUnregistered.inc({ reason, transport: record.kind });
      await refreshActiveGauge();
    }
    return sendJson(res, 200, { ok: result.ok });
  }

  return sendJson(res, 400, { error: 'Unsupported JMAP push type' });
}

// The request log shows a 200 for most failed forwards, so this line is the
// only record of why a device missed a push.
function logForwardFailure(
  id: string,
  record: SubscriptionRecord,
  outcome: ForwardOutcome,
  result: SendResult,
): void {
  const fields = {
    subscriptionId: id,
    transport: record.kind,
    host: pushServiceHost(record),
    outcome,
    status: result.status,
    reason: result.reason,
  };
  // An expired subscription is routine cleanup, not a delivery problem.
  if (outcome === 'unregistered') logger.info('relay: push subscription gone', fields);
  else logger.warn('relay: push not delivered', fields);
}

async function dispatch(
  record: SubscriptionRecord,
  payload: ForwardPayload,
): Promise<SendResult> {
  if (record.kind === 'fcm') {
    const timer = fcmDurationSeconds.startTimer();
    const result = await sendFcmPush(record, payload);
    timer();
    return result;
  }
  if (record.kind === 'apns') {
    const timer = apnsDurationSeconds.startTimer();
    const result = await sendApnsPush(record, payload);
    timer();
    return result;
  }
  if (record.kind === 'up') {
    const timer = upDurationSeconds.startTimer();
    const result = await sendUnifiedPush(record, payload);
    timer();
    return result;
  }
  const timer = webPushDurationSeconds.startTimer();
  const result = await sendWebPush(record, payload);
  timer();
  return result;
}

// Refresh the active-subscriptions gauge by counting per-transport. Called
// after every register/unregister and on every /metrics scrape so the gauge
// stays consistent with the on-disk state.
async function refreshActiveGauge(): Promise<void> {
  const counts = await subscriptionStore.sizeByKind();
  subscriptionsActive.set({ transport: 'fcm' }, counts.fcm);
  subscriptionsActive.set({ transport: 'apns' }, counts.apns);
  subscriptionsActive.set({ transport: 'web' }, counts.web);
  subscriptionsActive.set({ transport: 'up' }, counts.up);
}

function normalizeRoute(method: string, path: string): string {
  if (path === '/' || path === '/index.html') return '/';
  if (path === '/api/health') return '/api/health';
  if (path === '/metrics') return '/metrics';
  if (path === '/api/push/vapid-public-key') return '/api/push/vapid-public-key';
  if (method === 'POST' && path === '/api/push/register') return '/api/push/register';
  if (method === 'POST' && path === '/api/push/register/web') return '/api/push/register/web';
  if (method === 'POST' && path === '/api/push/register/unifiedpush') return '/api/push/register/unifiedpush';
  if (method === 'POST' && path === '/api/push/register/apns') return '/api/push/register/apns';
  if (/^\/api\/push\/register\/[^/]+$/.test(path)) return '/api/push/register/:id';
  if (/^\/api\/push\/verify\/[^/]+$/.test(path)) return '/api/push/verify/:id';
  if (/^\/api\/push\/active\/[^/]+$/.test(path)) return '/api/push/active/:id';
  if (/^\/api\/push\/jmap\/[^/]+$/.test(path)) return '/api/push/jmap/:id';
  return 'other';
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const route = normalizeRoute(method, path);
  const httpTimer = httpDurationSeconds.startTimer({ method, route });

  applyCors(req, res);
  if (method === 'OPTIONS') {
    // Preflight: 204 with the CORS headers already set above.
    res.writeHead(204);
    res.end();
    httpTimer();
    httpRequestsTotal.inc({ method, route, status: '204' });
    return;
  }

  try {
    if (method === 'GET' && path === '/metrics') {
      await refreshActiveGauge();
      const body = await registry.metrics();
      res.writeHead(200, {
        'content-type': registry.contentType,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && path === '/api/health') {
      const count = await subscriptionStore.size();
      return sendJson(res, 200, { ok: true, subscriptions: count });
    }

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const accept = req.headers.accept ?? '';
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        return sendJson(res, 200, {
          service: 'bulwark-push-relay',
          repo: REPO_URL,
          health: '/api/health',
        });
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(LANDING_HTML),
        'cache-control': 'public, max-age=300',
      });
      res.end(LANDING_HTML);
      return;
    }

    if (method === 'POST' && path === '/api/push/register') {
      return await handleRegister(req, res);
    }

    if (method === 'POST' && path === '/api/push/register/web') {
      return await handleRegisterWeb(req, res);
    }

    if (method === 'POST' && path === '/api/push/register/unifiedpush') {
      return await handleRegisterUnifiedPush(req, res);
    }

    if (method === 'POST' && path === '/api/push/register/apns') {
      return await handleRegisterApns(req, res);
    }

    if (method === 'GET' && path === '/api/push/vapid-public-key') {
      const key = getVapidPublicKey();
      if (!key) {
        return sendJson(res, 503, { error: 'Web Push not configured' });
      }
      return sendJson(res, 200, { publicKey: key });
    }

    const registerIdMatch = path.match(/^\/api\/push\/register\/([^/]+)$/);
    if (method === 'DELETE' && registerIdMatch) {
      return await handleUnregister(decodeURIComponent(registerIdMatch[1]), res);
    }

    const verifyMatch = path.match(/^\/api\/push\/verify\/([^/]+)$/);
    if (method === 'GET' && verifyMatch) {
      return await handleVerifyPoll(decodeURIComponent(verifyMatch[1]), res);
    }

    const activeMatch = path.match(/^\/api\/push\/active\/([^/]+)$/);
    if (method === 'GET' && activeMatch) {
      return await handleActivePoll(decodeURIComponent(activeMatch[1]), res);
    }

    const jmapMatch = path.match(/^\/api\/push\/jmap\/([^/]+)$/);
    if (method === 'POST' && jmapMatch) {
      return await handleJmap(req, decodeURIComponent(jmapMatch[1]), res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'Payload too large') {
      return sendJson(res, 413, { error: msg });
    }
    logger.error('relay: handler failed', { method, path, error: msg });
    if (!res.headersSent) {
      return sendJson(res, 500, { error: 'Internal server error' });
    }
    res.end();
  } finally {
    httpTimer();
    httpRequestsTotal.inc({ method, route, status: String(res.statusCode) });
    logger.info('relay: request', {
      method,
      path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  }
});

server.listen(PORT, HOST, () => {
  logger.info('relay: listening', { host: HOST, port: PORT });
});

const shutdown = (signal: string) => {
  logger.info('relay: shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
