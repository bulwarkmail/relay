import webpush from 'web-push';
import https from 'node:https';
import { isNotPublicError, isPublicEndpointUrl, publicOnlyAgent } from './endpoint-guard.js';
import { endpointRefused, getVapidPublicKey } from './webpush.js';
import { failureReason, forwardTimeoutMs, type SendResult } from './forward-result.js';
import { parseRetryAfter, type DeliveryOptions } from './forward-policy.js';
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
  delivery: DeliveryOptions,
): Promise<SendResult> {
  if (!isPublicEndpointUrl(record.endpoint)) return endpointRefused();
  const body = JSON.stringify(payload);

  if (record.keys) {
    // Force VAPID configuration to run so the global details are set when the
    // operator provided keys; sending proceeds without them otherwise.
    getVapidPublicKey();
    try {
      const res = await webpush.sendNotification(
        { endpoint: record.endpoint, keys: record.keys },
        body,
        { TTL: TTL_SECONDS, urgency: delivery.urgency, timeout: forwardTimeoutMs(), agent: publicOnlyAgent },
      );
      return { ok: true, status: res.statusCode, unregistered: false };
    } catch (error) {
      if (isNotPublicError(error)) return endpointRefused();
      const status = (error as { statusCode?: number }).statusCode ?? 0;
      // 404 / 410 mean the distributor dropped the registration - mirrors the
      // FCM UNREGISTERED branch so the caller deletes the record.
      const retryAfterSeconds = parseRetryAfter((error as { headers?: Record<string, unknown> }).headers?.['retry-after']);
      return {
        ok: false,
        status,
        unregistered: status === 404 || status === 410,
        reason: failureReason(error),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }
  }

  try {
    const { status, text, retryAfter } = await postPlain(record.endpoint, body, delivery);
    const ok = status >= 200 && status < 300;
    const retryAfterSeconds = parseRetryAfter(retryAfter);
    return {
      ok,
      status,
      unregistered: status === 404 || status === 410,
      reason: ok ? undefined : failureReason(text || `HTTP ${status}`),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  } catch (error) {
    if (isNotPublicError(error)) return endpointRefused();
    return { ok: false, status: 0, unregistered: false, reason: failureReason(error) };
  }
}

// Not fetch: it follows redirects, and a distributor could send the relay
// anywhere with one. A redirect counts as a failure here.
function postPlain(
  endpoint: string,
  body: string,
  delivery: DeliveryOptions,
): Promise<{ status: number; text: string; retryAfter: unknown }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      endpoint,
      {
        method: 'POST',
        agent: publicOnlyAgent,
        timeout: forwardTimeoutMs(),
        headers: {
          TTL: String(TTL_SECONDS),
          Urgency: delivery.urgency,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        // Always drain so the socket can be reused; the body only matters as
        // the distributor's explanation of a failure.
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (text.length < 1024) text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, retryAfter: res.headers['retry-after'] }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Socket timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
