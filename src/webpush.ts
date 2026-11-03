import webpush from 'web-push';
import { logger } from './logger.js';
import { isNotPublicError, isPublicEndpointUrl, postToEndpoint } from './endpoint-guard.js';
import { failureReason, forwardTimeoutMs, type SendResult } from './forward-result.js';
import { parseRetryAfter, type DeliveryOptions } from './forward-policy.js';
import type { ForwardPayload, WebSubscriptionRecord } from './types.js';

// Drop the message if the device stays offline for an hour.
const PUSH_TTL_SECONDS = 60 * 60;

let configured = false;
let publicKey: string | null = null;

function ensureConfigured(): boolean {
  if (configured) return publicKey !== null;
  configured = true;

  const pub = process.env.VAPID_PUBLIC_KEY?.trim();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  // RFC 8292 requires a contact - mailto: or https: URL the push service can
  // reach if our pushes start misbehaving. Default to a sensible self-host
  // hint so dev deployments still work without explicit config.
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:postmaster@localhost';

  if (!pub || !priv) {
    logger.warn('webpush: VAPID keys not configured - web push disabled');
    return false;
  }

  webpush.setVapidDetails(subject, pub, priv);
  publicKey = pub;
  return true;
}

export function getVapidPublicKey(): string | null {
  ensureConfigured();
  return publicKey;
}

// A record from before these checks, or a host whose DNS changed. It will never
// be called, so the caller removes it.
export function endpointRefused(): SendResult {
  return { ok: false, status: 0, unregistered: true, reason: 'endpoint is not a public address' };
}

export async function sendWebPush(
  record: WebSubscriptionRecord,
  payload: ForwardPayload,
  delivery: DeliveryOptions,
): Promise<SendResult> {
  if (!ensureConfigured()) {
    return { ok: false, status: 0, unregistered: false, reason: 'VAPID keys not configured' };
  }

  // Mirror the FCM payload shape: a wake-up ping plus, at most, the ids of the
  // delivered messages. The service worker turns this into an enriched system
  // notification by JMAP-fetching the email itself - so the relay never sees
  // mail content.
  if (!isPublicEndpointUrl(record.webPush.endpoint)) return endpointRefused();

  try {
    return await sendEncrypted(record.webPush, payload, {
      urgency: delivery.urgency,
      ...(delivery.topic ? { topic: delivery.topic } : {}),
    });
  } catch (error) {
    if (isNotPublicError(error)) return endpointRefused();
    return { ok: false, status: 0, unregistered: false, reason: failureReason(error) };
  }
}

// The library builds and encrypts the request (RFC 8291, VAPID when configured).
// Sending it stays here, see postToEndpoint. 404 and 410 mean the service dropped
// the subscription: the caller deletes the record.
export async function sendEncrypted(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: ForwardPayload,
  options: { urgency: string; topic?: string },
): Promise<SendResult> {
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
    TTL: PUSH_TTL_SECONDS,
    ...options,
  } as webpush.RequestOptions);
  const { status, text, retryAfter } = await postToEndpoint(
    subscription.endpoint,
    details.headers as Record<string, string | number>,
    details.body as Buffer,
    forwardTimeoutMs(),
  );
  const ok = status >= 200 && status < 300;
  const retryAfterSeconds = parseRetryAfter(retryAfter);
  return {
    ok,
    status,
    unregistered: status === 404 || status === 410,
    reason: ok ? undefined : failureReason(text || `HTTP ${status}`),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
