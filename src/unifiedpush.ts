import webpush from 'web-push';
import { getVapidPublicKey } from './webpush.js';
import { failureReason, type SendResult } from './forward-result.js';
import type { ForwardPayload, UnifiedPushSubscriptionRecord } from './types.js';

// Drop the message if the device stays unreachable for an hour - matches the
// Web Push transport; the app re-syncs over JMAP on next launch anyway.
const TTL_SECONDS = 60 * 60;

/**
 * Deliver a payload to a UnifiedPush endpoint. Modern connectors (>= 3.0)
 * hand out RFC 8291 keys, so the message goes out as standard encrypted Web
 * Push - identical to the PWA path. Unlike browser push services, UnifiedPush
 * distributors don't require VAPID, so a relay without configured VAPID keys
 * can still serve UnifiedPush devices (the web-push library simply omits the
 * Authorization header when no VAPID details are set).
 *
 * `keys: null` marks a registration from a legacy distributor without Web
 * Push support: those get the payload as a plain POST of the JSON bytes, the
 * original UnifiedPush delivery style. The payload is a content-blind wake-up
 * ping either way.
 */
export async function sendUnifiedPush(
  record: UnifiedPushSubscriptionRecord,
  payload: ForwardPayload,
): Promise<SendResult> {
  const body = JSON.stringify(payload);

  if (record.keys) {
    // Force VAPID configuration to run so the global details are set when the
    // operator provided keys; sending proceeds without them otherwise.
    getVapidPublicKey();
    try {
      const res = await webpush.sendNotification(
        { endpoint: record.endpoint, keys: record.keys },
        body,
        { TTL: TTL_SECONDS, urgency: 'high' },
      );
      return { ok: true, status: res.statusCode, unregistered: false };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 0;
      // 404 / 410 mean the distributor dropped the registration - mirrors the
      // FCM UNREGISTERED branch so the caller deletes the record.
      return {
        ok: false,
        status,
        unregistered: status === 404 || status === 410,
        reason: failureReason(error),
      };
    }
  }

  try {
    const res = await fetch(record.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(TTL_SECONDS),
        Urgency: 'high',
        'content-type': 'application/json',
      },
      body,
    });
    // Always drain so the socket can be reused; the body only matters as the
    // distributor's explanation of a failure.
    const text = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      unregistered: res.status === 404 || res.status === 410,
      reason: res.ok ? undefined : failureReason(text),
    };
  } catch (error) {
    return { ok: false, status: 0, unregistered: false, reason: failureReason(error) };
  }
}
