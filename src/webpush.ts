import webpush from 'web-push';
import { logger } from './logger.js';
import { failureReason, type SendResult } from './forward-result.js';
import type { ForwardPayload, WebSubscriptionRecord } from './types.js';

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

export async function sendWebPush(
  record: WebSubscriptionRecord,
  payload: ForwardPayload,
): Promise<SendResult> {
  if (!ensureConfigured()) {
    return { ok: false, status: 0, unregistered: false, reason: 'VAPID keys not configured' };
  }

  // Mirror the FCM payload shape: a wake-up ping plus, at most, the ids of the
  // delivered messages. The service worker turns this into an enriched system
  // notification by JMAP-fetching the email itself - so the relay never sees
  // mail content.
  try {
    const res = await webpush.sendNotification(record.webPush, JSON.stringify(payload), {
      TTL: 60 * 60, // seconds — drop if the device is offline for an hour
      urgency: 'high',
    });
    return { ok: true, status: res.statusCode, unregistered: false };
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode ?? 0;
    // 404 / 410 mean the push service has dropped the subscription -
    // mirrors the FCM UNREGISTERED branch so the caller deletes the record.
    const unregistered = status === 404 || status === 410;
    return { ok: false, status, unregistered, reason: failureReason(error) };
  }
}
