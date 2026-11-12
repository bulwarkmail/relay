import { isNotPublicError, isPublicEndpointUrl, postToEndpoint } from './endpoint-guard.js';
import { endpointRefused, getVapidPublicKey, sendEncrypted } from './webpush.js';
import { failureReason, forwardTimeoutMs, type SendResult } from './forward-result.js';
import { parseRetryAfter, type DeliveryOptions } from './forward-policy.js';
import type { ForwardPayload, UnifiedPushSubscriptionRecord } from './types.js';

// Drop the message if the device stays unreachable for an hour - matches the
// Web Push transport; the app re-syncs over JMAP on next launch anyway.
const TTL_SECONDS = 60 * 60;

// Without keys the payload goes out as readable JSON to wherever the endpoint
// points. The label goes with it only when it looks like a sign-in name, which
// is what the app registers; anything else goes as an empty string.
const PLAIN_LABEL = /^[\w.@+-]{1,120}$/;

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

  try {
    if (record.keys) {
      // Force VAPID configuration to run so the global details are set when the
      // operator provided keys; sending proceeds without them otherwise.
      getVapidPublicKey();
      return await sendEncrypted({ endpoint: record.endpoint, keys: record.keys }, payload, { urgency: delivery.urgency });
    }
    const body = JSON.stringify(PLAIN_LABEL.test(payload.accountLabel) ? payload : { ...payload, accountLabel: '' });
    const { status, text, retryAfter } = await postToEndpoint(
      record.endpoint,
      {
        TTL: TTL_SECONDS,
        Urgency: delivery.urgency,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      body,
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
  } catch (error) {
    // Unlike a refused name, what a name resolves to changes: this is a temporary
    // failure, so one bad DNS answer doesn't cost the device its record.
    return { ok: false, status: 0, unregistered: false, reason: isNotPublicError(error) ? 'endpoint resolves to no public address' : failureReason(error) };
  }
}
