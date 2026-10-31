import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http2 from 'node:http2';
import path from 'node:path';
import { failureReason, type SendResult } from './forward-result.js';
import type { ApnsSubscriptionRecord, ForwardPayload } from './types.js';

// Direct delivery to Apple Push Notification service for the iOS app.
//
// Token-based auth: a .p8 signing key (APNS_KEY: inline PEM or a path,
// default <PUSH_DATA_DIR>/apns-key.p8), its key id (APNS_KEY_ID) and the
// team id (APNS_TEAM_ID). The JWT is reused for 40 minutes; Apple rejects
// one older than an hour and throttles fresh ones more often than every 20.
//
// Content-blind like the other transports: the push carries a fixed
// placeholder text and the ids, never a subject or sender. The app's
// Notification Service Extension fetches those over its own JMAP session on
// the device and rewrites the notification before it is shown.

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

const JWT_LIFETIME_MS = 40 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

let configPromise: Promise<ApnsConfig | null> | null = null;
let cachedJwt: { token: string; issuedAt: number } | null = null;
const sessions = new Map<string, http2.ClientHttp2Session>();

async function loadConfig(): Promise<ApnsConfig | null> {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  if (!keyId || !teamId) return null;
  const inline = process.env.APNS_KEY?.trim();
  let keyPem: string;
  if (inline && inline.startsWith('-----BEGIN')) {
    keyPem = inline;
  } else {
    const file = inline || path.join(process.env.PUSH_DATA_DIR ?? './data', 'apns-key.p8');
    try {
      keyPem = await fs.readFile(file, 'utf8');
    } catch {
      return null;
    }
  }
  return { keyPem, keyId, teamId, topic: process.env.APNS_TOPIC?.trim() || 'org.bulwarkmail.mobile' };
}

/** The APNs configuration, or null when the relay has no key (APNs off). */
export function getApnsConfig(): Promise<ApnsConfig | null> {
  configPromise ??= loadConfig();
  return configPromise;
}

/** Test hook: forget the configuration, the JWT and open connections. */
export function resetApnsState(config?: ApnsConfig | null): void {
  configPromise = config === undefined ? null : Promise.resolve(config);
  cachedJwt = null;
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function apnsJwt(config: ApnsConfig, now = Date.now()): string {
  if (cachedJwt && now - cachedJwt.issuedAt < JWT_LIFETIME_MS) return cachedJwt.token;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: config.keyPem,
    dsaEncoding: 'ieee-p1363',
  });
  const token = `${header}.${claims}.${base64url(signature)}`;
  cachedJwt = { token, issuedAt: now };
  return token;
}

/**
 * The notification Apple shows if the app's extension can't fetch the
 * message. Only ids leave the relay; `mutable-content` hands the
 * notification to the extension first.
 */
export function apnsPayload(payload: ForwardPayload): Record<string, unknown> {
  return {
    aps: {
      alert: { title: 'Bulwark Mail', body: 'New message' },
      sound: 'default',
      'mutable-content': 1,
      // Groups the notifications of one account.
      'thread-id': payload.accountId || payload.accountLabel,
    },
    // expo-notifications hands an app `userInfo.body` as the notification's
    // data, so the ids go there; the extension adds the message it showed.
    body: {
      kind: payload.kind,
      accountLabel: payload.accountLabel,
      accountId: payload.accountId,
      emailIds: payload.emailIds,
      changed: payload.changed,
    },
  };
}

// APNs reasons that mean the token will never work again here: the app was
// removed, or the token belongs to the other environment or another topic.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export function classifyApnsResponse(status: number, body: string): SendResult {
  let reason: string | undefined;
  try {
    reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
  } catch {
    reason = body || undefined;
  }
  const ok = status === 200;
  return {
    ok,
    status,
    unregistered: status === 410 || (status === 400 && !!reason && DEAD_TOKEN_REASONS.has(reason)),
    reason: ok ? undefined : failureReason(reason ?? `HTTP ${status}`),
  };
}

function sessionFor(origin: string): http2.ClientHttp2Session {
  const existing = sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const session = http2.connect(origin);
  const forget = () => {
    if (sessions.get(origin) === session) sessions.delete(origin);
  };
  session.on('close', forget);
  session.on('error', forget);
  session.on('goaway', forget);
  // Don't keep the process alive just for an idle connection.
  session.unref();
  sessions.set(origin, session);
  return session;
}

export async function sendApnsPush(
  record: ApnsSubscriptionRecord,
  payload: ForwardPayload,
): Promise<SendResult> {
  const config = await getApnsConfig();
  if (!config) {
    return { ok: false, status: 0, unregistered: false, reason: 'APNs not configured on this relay' };
  }
  // APNS_ORIGIN points every push at another server (tests, a local mock).
  const origin = process.env.APNS_ORIGIN || HOSTS[record.environment];
  const body = JSON.stringify(apnsPayload(payload));
  const session = sessionFor(origin);
  return new Promise<SendResult>((resolve, reject) => {
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${record.deviceToken}`,
      authorization: `bearer ${apnsJwt(config)}`,
      'apns-topic': config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      // A day: mail older than that is better found by opening the app.
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 24 * 3600),
      'content-type': 'application/json',
    });
    let status = 0;
    let text = '';
    req.setEncoding('utf8');
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on('response', (headers) => {
      status = Number(headers[':status'] ?? 0);
    });
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => {
      // A stream closed without a response (timeout, reset) has no status.
      if (status === 0) {
        resolve({ ok: false, status: 0, unregistered: false, reason: 'no response from APNs' });
        return;
      }
      resolve(classifyApnsResponse(status, text));
    });
    req.on('error', reject);
    req.end(body);
  });
}
