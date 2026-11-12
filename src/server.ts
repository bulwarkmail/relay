import http from 'node:http';
import { URL } from 'node:url';
import { logger } from './logger.js';
import { MAX_REGISTRATION_BYTES, mayPush, mayUse, recordBytes, subscriptionStore } from './store.js';
import { isFcmConfigured, sendFcmPush } from './fcm.js';
import { getApnsConfig, sendApnsPush } from './apns.js';
import { getVapidPublicKey, sendWebPush } from './webpush.js';
import { sendUnifiedPush } from './unifiedpush.js';
import { isForwardableBody, subOf, toForwardPayload } from './payload.js';
import { deliveryOptions, forwardPolicy, type DeliveryOptions } from './forward-policy.js';
import { clientKey, takeRegistration } from './client-limit.js';
import {
  classifyForward,
  failureReason,
  forwardTimeoutMs,
  isTemporaryFailure,
  logRef,
  pushServiceHost,
  statusLabel,
  type ForwardOutcome,
  type SendResult,
} from './forward-result.js';
import {
  accountLabelOf,
  isValidApnsEnvironment,
  isValidApnsToken,
  isValidFcmToken,
  isValidPushKey,
  isValidSecret,
  isValidSubscriptionId,
  isValidVerificationCode,
  mayTakeSecret,
  normalizeEndpoint,
  normalizeKeys,
  normalizeWebPushSubscription,
  pushKeyOf,
  secretHashOf,
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
  metricsAuthorized,
  metricsToken,
  httpRequestsTotal,
  httpDurationSeconds,
  subscriptionsRegistered,
  subscriptionsUnregistered,
  subscriptionsActive,
  pushesReceived,
  pushesForwarded,
  pushesHeld,
  fcmDurationSeconds,
  apnsDurationSeconds,
  webPushDurationSeconds,
  upDurationSeconds,
} from './metrics.js';

const PORT = Number(process.env.PORT ?? 3003);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024;
const OVERSIZE_GRACE_MS = 2000;
// A push within this long of the last one doesn't move lastPushAt: nothing that
// reads it (/active, the expiry) cares about a minute.
const LAST_PUSH_RESOLUTION_MS = 60 * 1000;
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
<p>When your mail server has something new, this pings your phone.</p>
<p>It doesn't see the mail, not even the subject or the sender. All it gets is a push token and the ping.</p>
<p>Source: <a href="${REPO_URL}">${REPO_URL}</a></p>
</body>
</html>
`;

class PayloadTooLargeError extends Error {}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // The rest is read and thrown away: closing the socket now would reset
        // the connection before the caller gets to see the 413.
        tooLarge = true;
        chunks.length = 0;
        reject(new PayloadTooLargeError('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
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
// frontend, so we serve permissive CORS. There are no cookies in any request,
// so `*` here is safe: what proves a caller owns a record is a secret the
// browser sends itself, in the body or the Authorization header.
const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
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

// Records the store takes. An id that is there can always register again; a new
// one past the limit takes the place of a record that may give way (see store.ts)
// or is refused.
const DEFAULT_MAX_SUBSCRIPTIONS = 50_000;
// Records one client address may hold, where the relay can tell addresses apart:
// far more than a household or an office has devices and accounts, far fewer than
// the store takes.
const DEFAULT_MAX_SUBSCRIPTIONS_PER_ADDRESS = 1_000;

function countEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

let fullLoggedAt = 0;
let addressFullLoggedAt = 0;

/** Stores a registration, or answers 507 when there is no room for it. Says whether it stored. */
async function store(req: http.IncomingMessage, res: http.ServerResponse, id: string, record: SubscriptionRecord): Promise<boolean> {
  // Every field has a limit of its own, which keeps a registration under this;
  // the store holds no record larger than MAX_RECORD_BYTES whatever comes in.
  if (recordBytes(record) > MAX_REGISTRATION_BYTES) {
    sendJson(res, 400, { error: 'Registration too large' });
    return false;
  }
  const limit = countEnv('PUSH_MAX_SUBSCRIPTIONS', DEFAULT_MAX_SUBSCRIPTIONS);
  const perAddress = countEnv('PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS', DEFAULT_MAX_SUBSCRIPTIONS_PER_ADDRESS);
  const result = await subscriptionStore.put(id, record, { limit, address: clientKey(req), perAddress });
  if (result.stored) {
    if (result.evicted) {
      subscriptionsUnregistered.inc({ reason: 'evicted', transport: result.evicted.record.kind });
      forwardPolicy.remove(result.evicted.id);
    }
    return true;
  }
  if (result.reason === 'not-owner') {
    sendJson(res, 403, { error: NOT_OWNER });
    return false;
  }
  if (result.reason === 'taken') {
    sendJson(res, 409, { error: NO_SECRET_FOR_ID });
    return false;
  }
  if (result.reason === 'address-full') {
    if (Date.now() - addressFullLoggedAt > 60_000) {
      addressFullLoggedAt = Date.now();
      logger.warn('relay: a client address holds as many records as it may, its new devices are refused', { perAddress });
    }
    sendJson(res, 507, { error: 'Too many devices registered from this address' });
    return false;
  }
  if (Date.now() - fullLoggedAt > 60_000) {
    fullLoggedAt = Date.now();
    logger.warn('relay: the store is full, new devices are refused', { limit });
  }
  sendJson(res, 507, { error: 'Relay is full' });
  return false;
}

// A record registered with a secret belongs to whoever holds that secret: the
// store keeps its hash (see store.ts, put). A registration for its id brings
// the same secret in the body; DELETE and the verification poll send it as
// `Authorization: Bearer <secret>`. The mail server's push URL carries the push
// key derived from it (pushKeyOf) as `?k=<push key>`, since a URL is all the mail
// server has and it stores and may log that URL: the key pushes and owns nothing.
// Each route looks in its one place and nowhere else, so a proxy's access log can
// be told what to drop. A record without a secret works by its id alone on every
// route, whatever header or query comes along, as it always has.
const NOT_OWNER = 'Wrong or missing secret for this subscription';
const NO_PUSH_KEY = 'Wrong or missing push key for this subscription';
const NO_SECRET_FOR_ID = 'This subscription id cannot take a secret; register a new id of 40 characters or more with it';

interface Owner {
  secretHash: string;
  pushKeyHash: string;
}

/**
 * What a registration that brings a secret binds the record to: the hashes of
 * the secret and of its push key. Undefined when it brings none, null after
 * answering a `secret` the relay can't take (400), or one for an id that may not
 * take a secret (409, see mayTakeSecret).
 */
function registeredSecret(res: http.ServerResponse, id: string, value: unknown): Owner | undefined | null {
  if (value === undefined) return undefined;
  if (!isValidSecret(value)) {
    sendJson(res, 400, { error: 'Invalid secret' });
    return null;
  }
  if (!mayTakeSecret(id)) {
    sendJson(res, 409, { error: NO_SECRET_FOR_ID });
    return null;
  }
  return { secretHash: secretHashOf(value), pushKeyHash: secretHashOf(pushKeyOf(value)) };
}

/**
 * A stored registration's answer. One that brought a secret hears that the
 * record is bound to it: a relay from before secrets answers `{ ok: true }` to
 * the same body, so a client can tell whether to send the secret later, which a
 * browser can only do to a relay whose CORS answer allows the header.
 */
function registered(owner: Owner | undefined) {
  return owner ? { ok: true, owned: true } : { ok: true };
}

/** The hash of the secret in `Authorization: Bearer <secret>`, or null. */
function bearerSecret(req: http.IncomingMessage): string | null {
  const match = /^Bearer +([^\s]+)$/i.exec((req.headers.authorization ?? '').trim());
  return match && isValidSecret(match[1]) ? secretHashOf(match[1]) : null;
}

/** The hash of the push key in the query's one `k`, decoded, or null. Two `k` count as none. */
function queryPushKey(query: URLSearchParams): string | null {
  const values = query.getAll('k');
  return values.length === 1 && isValidPushKey(values[0]) ? secretHashOf(values[0]) : null;
}

// What a new registration keeps from the record it replaces. A backoff the push
// service asked for stays with the endpoint: see forward-policy.ts.
function carriedOver(existing: SubscriptionRecord | null) {
  const now = Date.now();
  return {
    createdAt: existing?.createdAt ?? now,
    lastPushAt: existing?.lastPushAt ?? null,
    lastRegisteredAt: now,
    ...(existing?.codeCollectedAt ? { codeCollectedAt: existing.codeCollectedAt } : {}),
  };
}

async function handleRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // Refused up front like the other transports: the app gets told now, instead
  // of a record that looks fine and a 500 on every push.
  if (!(await isFcmConfigured())) {
    return sendJson(res, 503, { error: 'FCM not configured' });
  }
  const body = (await readJson(req)) as
    | { subscriptionId?: unknown; fcmToken?: unknown; accountLabel?: unknown; secret?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, fcmToken, accountLabel, secret } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidFcmToken(fcmToken)) {
    return sendJson(res, 400, { error: 'Invalid fcmToken' });
  }
  const label = accountLabelOf(accountLabel);
  if (label === null) {
    return sendJson(res, 400, { error: 'Invalid accountLabel' });
  }
  const owner = registeredSecret(res, subscriptionId, secret);
  if (owner === null) return;

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
    ...carriedOver(existing),
    accountLabel: label,
    ...owner,
  };
  if (!(await store(req, res, subscriptionId, record))) return;
  subscriptionsRegistered.inc({ transport: 'fcm' });
  return sendJson(res, 200, registered(owner));
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
    | { subscriptionId?: unknown; deviceToken?: unknown; environment?: unknown; accountLabel?: unknown; secret?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, deviceToken, environment, accountLabel, secret } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidApnsToken(deviceToken)) {
    return sendJson(res, 400, { error: 'Invalid deviceToken' });
  }
  if (!isValidApnsEnvironment(environment)) {
    return sendJson(res, 400, { error: 'Invalid environment' });
  }
  const label = accountLabelOf(accountLabel);
  if (label === null) {
    return sendJson(res, 400, { error: 'Invalid accountLabel' });
  }
  const owner = registeredSecret(res, subscriptionId, secret);
  if (owner === null) return;

  const existing = await subscriptionStore.get(subscriptionId);
  const record: ApnsSubscriptionRecord = {
    kind: 'apns',
    deviceToken: deviceToken.toLowerCase(),
    environment,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    ...carriedOver(existing),
    accountLabel: label,
    ...owner,
  };
  if (!(await store(req, res, subscriptionId, record))) return;
  subscriptionsRegistered.inc({ transport: 'apns' });
  return sendJson(res, 200, registered(owner));
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
        secret?: unknown;
      }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, subscription, accountLabel, secret } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  const webPush = normalizeWebPushSubscription(subscription);
  if (!webPush) {
    return sendJson(res, 400, { error: 'Invalid subscription' });
  }
  const label = accountLabelOf(accountLabel);
  if (label === null) {
    return sendJson(res, 400, { error: 'Invalid accountLabel' });
  }
  const owner = registeredSecret(res, subscriptionId, secret);
  if (owner === null) return;

  const existing = await subscriptionStore.get(subscriptionId);
  const record: WebSubscriptionRecord = {
    kind: 'web',
    webPush,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    ...carriedOver(existing),
    accountLabel: label,
    ...owner,
  };
  if (!(await store(req, res, subscriptionId, record))) return;
  subscriptionsRegistered.inc({ transport: 'web' });
  return sendJson(res, 200, registered(owner));
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
        secret?: unknown;
      }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, endpoint, keys, accountLabel, secret } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  const target = normalizeEndpoint(endpoint);
  if (!target) {
    return sendJson(res, 400, { error: 'Invalid endpoint' });
  }
  const webPushKeys = keys == null ? null : normalizeKeys(keys);
  if (keys != null && !webPushKeys) {
    return sendJson(res, 400, { error: 'Invalid keys' });
  }
  const label = accountLabelOf(accountLabel);
  if (label === null) {
    return sendJson(res, 400, { error: 'Invalid accountLabel' });
  }
  const owner = registeredSecret(res, subscriptionId, secret);
  if (owner === null) return;

  const existing = await subscriptionStore.get(subscriptionId);
  const record: UnifiedPushSubscriptionRecord = {
    kind: 'up',
    endpoint: target,
    keys: webPushKeys,
    // See handleRegister for why we always reset this.
    verificationCode: null,
    ...carriedOver(existing),
    accountLabel: label,
    ...owner,
  };
  if (!(await store(req, res, subscriptionId, record))) return;
  subscriptionsRegistered.inc({ transport: 'up' });
  return sendJson(res, 200, registered(owner));
}

async function handleUnregister(
  req: http.IncomingMessage,
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  // Look up the record before deleting so we can attribute the unregister to
  // the right transport in metrics.
  const existing = await subscriptionStore.get(id);
  if ((await subscriptionStore.delete(id, bearerSecret(req))) === 'not-owner') {
    return sendJson(res, 403, { error: NOT_OWNER });
  }
  forwardPolicy.remove(id);
  subscriptionsUnregistered.inc({
    reason: 'client',
    transport: existing?.kind ?? 'unknown',
  });
  return sendJson(res, 200, { ok: true });
}

async function handleVerifyPoll(
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
  // Before anything is noted: a refused poll doesn't make the record look
  // collected, and so alive, to the owner's other devices.
  if (!mayUse(record, bearerSecret(req))) {
    return sendJson(res, 403, { error: NOT_OWNER });
  }
  if (record.verificationCode && !record.codeCollectedAt) {
    await subscriptionStore.updateIfCurrent(id, record, (current) => {
      current.codeCollectedAt = Date.now();
    });
  }
  return sendJson(res, 200, { verificationCode: record.verificationCode ?? null });
}

// Liveness probe used by clients during setup to decide whether a leftover JMAP
// PushSubscription on the account belongs to a still-active device (keep it) or
// is dead debris starving the new one's verification (safe to reap). Stalwart
// hides a subscription's verified state and URL from clients, so the relay -
// which sees the actual push traffic - is the only place that can tell them
// apart. A working subscription has either forwarded a push or, on an account
// that has had no mail yet, had its verification code picked up by the client.
// One that never verified has done neither, and is the debris this is for.
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
    record.lastPushAt != null ||
    record.codeCollectedAt != null ||
    Date.now() - record.createdAt < ACTIVE_GRACE_MS;
  return sendJson(res, 200, { active });
}

async function handleJmap(
  req: http.IncomingMessage,
  id: string,
  query: URLSearchParams,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }

  // Only the push URL the owner gave the mail server carries the push key.
  const presented = queryPushKey(query);
  let record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }
  if (!mayPush(record, presented)) {
    return sendJson(res, 403, { error: NO_PUSH_KEY });
  }

  const body = (await readJson(req)) as JmapPushBody | null | undefined;
  if (!body || typeof body !== 'object' || typeof body['@type'] !== 'string') {
    return sendJson(res, 400, { error: 'Invalid JMAP push body' });
  }
  // As it is now: a body can take its time, and a registration may have come in.
  record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }
  if (!mayPush(record, presented)) {
    return sendJson(res, 403, { error: NO_PUSH_KEY });
  }

  if (body['@type'] === 'PushVerification') {
    const code: unknown = body.verificationCode;
    if (!isValidVerificationCode(code)) {
      return sendJson(res, 400, { error: 'Invalid verification code' });
    }
    pushesReceived.inc({ type: 'PushVerification' });
    // The same code again changes nothing, so nothing is written.
    if (record.verificationCode !== code) {
      await subscriptionStore.updateIfCurrent(id, record, (current) => {
        current.verificationCode = code;
      });
    }
    return sendJson(res, 200, { ok: true });
  }

  // StateChange: the classic per-type ping. EmailPush: the server applied the
  // client's delivery filter (draft-ietf-jmap-emailpush) and lists the
  // messages that passed - both become the same content-blind device payload.
  if (isForwardableBody(body)) {
    pushesReceived.inc({ type: body['@type'] });
    const hold = forwardPolicy.hold(id, record);
    if (hold) {
      pushesHeld.inc({ reason: hold.reason, transport: record.kind });
      logger.info('relay: push held back', { subscription: logRef(id), transport: record.kind, ...hold });
      res.setHeader('retry-after', String(hold.retryAfterSeconds));
      // The relay's own limits answer 429; holds the push service asked for, 503.
      const ours = hold.reason === 'rate-limit' || hold.reason === 'endpoint-rate-limit';
      return sendJson(res, ours ? 429 : 503, { ok: false, held: hold.reason });
    }
    let result: SendResult;
    try {
      result = await dispatch(
        record,
        toForwardPayload(body, record.accountLabel, subOf(id)),
        deliveryOptions(id, body, req.headers.urgency),
      );
    } catch (error) {
      // FCM token minting and sending throw on network errors. Count and log
      // them like any other failed forward, then answer 500 as before so the
      // JMAP server may retry.
      const failed = { ok: false, status: 0, unregistered: false, reason: failureReason(error) };
      pushesForwarded.inc({ result: 'fail', transport: record.kind, status: 'none' });
      logForwardFailure(id, record, 'fail', failed);
      return sendJson(res, 500, { error: 'Internal server error' });
    }
    // A record replaced meanwhile points at another endpoint, which this says nothing about.
    if (await subscriptionStore.isCurrent(id, record)) forwardPolicy.note(record, result, subscriptionStore.addressOf(id));
    const outcome = classifyForward(result);
    pushesForwarded.inc({
      result: outcome,
      transport: record.kind,
      status: statusLabel(result.status),
    });
    if (outcome !== 'ok') logForwardFailure(id, record, outcome, result);
    // The push is out. A store that can't take the news is worth an error in the log,
    // not a failure answer that makes the mail server send it again.
    const logStoreFailure = (error: unknown) => {
      logger.error('relay: could not save after a forward', { error: error instanceof Error ? error.message : 'Unknown error' });
      return false;
    };
    if (result.unregistered) {
      const removed = await subscriptionStore.deleteIfCurrent(id, record).catch(logStoreFailure);
      const reason =
        record.kind === 'fcm'
          ? 'fcm-unregistered'
          : record.kind === 'apns'
            ? 'apns-unregistered'
            : record.kind === 'up'
              ? 'unifiedpush-gone'
              : 'webpush-gone';
      if (removed) {
        subscriptionsUnregistered.inc({ reason, transport: record.kind });
        forwardPolicy.remove(id);
      }
    } else if (result.ok && Date.now() - (record.lastPushAt ?? 0) >= LAST_PUSH_RESOLUTION_MS) {
      // Only what really went out: /active and the 90 days go by this.
      await subscriptionStore.updateIfCurrent(id, record, (current) => {
        current.lastPushAt = Date.now();
      }).catch(logStoreFailure);
    }
    if (result.retryAfterSeconds !== undefined) {
      res.setHeader('retry-after', String(result.retryAfterSeconds));
    }
    return sendJson(res, isTemporaryFailure(result) ? 503 : 200, { ok: result.ok });
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
    subscription: logRef(id),
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
  delivery: DeliveryOptions,
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
    const result = await sendUnifiedPush(record, payload, delivery);
    timer();
    return result;
  }
  const timer = webPushDurationSeconds.startTimer();
  const result = await sendWebPush(record, payload, delivery);
  timer();
  return result;
}

// Refresh the active-subscriptions gauge by counting per-transport, on every
// /metrics scrape: the count walks every record, which no other request does.
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

const REGISTER_ROUTES = new Set(['/api/push/register', '/api/push/register/web', '/api/push/register/unifiedpush', '/api/push/register/apns']);

function allowedMethod(path: string): string | null {
  // With metrics off, /metrics answers 404 to every method, like any unknown path.
  if (path === '/metrics') return metricsToken() ? 'GET' : null;
  if (['/api/health', '/api/push/vapid-public-key'].includes(path)) return 'GET';
  if (['/api/push/register', '/api/push/register/web', '/api/push/register/unifiedpush', '/api/push/register/apns'].includes(path)) return 'POST';
  if (/^\/api\/push\/register\/[^/]+$/.test(path)) return 'DELETE';
  if (/^\/api\/push\/(verify|active)\/[^/]+$/.test(path)) return 'GET';
  if (/^\/api\/push\/jmap\/[^/]+$/.test(path)) return 'POST';
  return null;
}

// The path routes the request. The query only matters on the push route, where
// it may carry the record's secret; it is never logged or used as a label.
function requestTarget(target: string | undefined): { path: string; query: URLSearchParams } | null {
  try {
    const url = new URL(target ?? '/', 'http://localhost');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return null;
  }
}

// Broken percent-encoding comes back as a string no id validator accepts, so
// the handler answers it like any other bad id.
function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}

// An unhandled rejection ends the process, so nothing that goes wrong with one
// request may get past this.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    logger.error('relay: request failed', { error: error instanceof Error ? error.message : 'Unknown error' });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const started = Date.now();
  const method = req.method ?? 'GET';
  // A request target like `//` is no URL at all. Thrown from here it would take
  // the whole process down, since this callback's promise has no handler.
  const target = requestTarget(req.url);
  if (target === null) {
    sendJson(res, 400, { error: 'Bad request target' });
    httpRequestsTotal.inc({ method, route: 'other', status: '400' });
    return;
  }
  const { path, query } = target;
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
      const token = metricsToken();
      if (!token) return sendJson(res, 404, { error: 'Not found' });
      if (!metricsAuthorized(req.headers.authorization, token)) {
        res.setHeader('www-authenticate', 'Bearer realm="metrics"');
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
      await refreshActiveGauge();
      const body = await registry.metrics();
      res.writeHead(200, {
        'content-type': registry.contentType,
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    // Up or not, nothing more: how many records there are is in /metrics.
    if (method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { ok: true });
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

    if (method === 'POST' && REGISTER_ROUTES.has(path)) {
      // Before anything is read: a registration past the address's budget stores nothing.
      const wait = takeRegistration(req);
      if (wait !== null) {
        res.setHeader('retry-after', String(wait));
        return sendJson(res, 429, { error: 'Too many registrations, try again later' });
      }
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
    // `/register/unifiedpush` would pass for an id here.
    if (method === 'DELETE' && registerIdMatch && allowedMethod(path) === 'DELETE') {
      return await handleUnregister(req, decodeId(registerIdMatch[1]), res);
    }

    const verifyMatch = path.match(/^\/api\/push\/verify\/([^/]+)$/);
    if (method === 'GET' && verifyMatch) {
      return await handleVerifyPoll(req, decodeId(verifyMatch[1]), res);
    }

    const activeMatch = path.match(/^\/api\/push\/active\/([^/]+)$/);
    if (method === 'GET' && activeMatch) {
      return await handleActivePoll(decodeId(activeMatch[1]), res);
    }

    const jmapMatch = path.match(/^\/api\/push\/jmap\/([^/]+)$/);
    if (method === 'POST' && jmapMatch) {
      return await handleJmap(req, decodeId(jmapMatch[1]), query, res);
    }

    const allowed = allowedMethod(path);
    if (allowed) {
      res.setHeader('allow', `${allowed}, OPTIONS`);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (error instanceof PayloadTooLargeError) {
      res.setHeader('connection', 'close');
      // Whoever keeps sending after the answer doesn't get to hold the socket.
      res.once('finish', () => setTimeout(() => req.destroy(), OVERSIZE_GRACE_MS).unref());
      return sendJson(res, 413, { error: msg });
    }
    logger.error('relay: handler failed', { method, route, error: msg });
    if (!res.headersSent) {
      return sendJson(res, 500, { error: 'Internal server error' });
    }
    res.end();
  } finally {
    httpTimer();
    httpRequestsTotal.inc({ method, route, status: String(res.statusCode) });
    const id = path.split('/').at(-1) ?? '';
    logger.info('relay: request', {
      method,
      route,
      ...(route.endsWith(':id') ? { subscription: logRef(decodeId(id)) } : {}),
      status: res.statusCode,
      ms: Date.now() - started,
    });
  }
}

subscriptionStore.load().then(
  () => {
    server.listen(PORT, HOST, () => {
      logger.info('relay: listening', { host: HOST, port: PORT });
    });
  },
  () => {
    // Already logged. A restart loop gets noticed; losing the store doesn't.
    process.exit(1);
  },
);

// Every change is on disk before it is answered; a stop doesn't change that. On
// the way out the journal goes into the snapshot, after the last change, so an
// older relay, which reads subscriptions.json only, finds every record there.
// A push still on its way gets its full deadline first.
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  void subscriptionStore.close().then((folded) => {
    if (!folded) logger.warn('relay: stopped with changes left in subscriptions.journal, which an older relay does not read');
    process.exit(code);
  });
};
const shutdown = (signal: string) => {
  logger.info('relay: shutting down', { signal });
  server.close(() => stop(0));
  setTimeout(() => stop(1), forwardTimeoutMs() + 1000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
