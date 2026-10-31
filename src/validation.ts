import type { WebPushSubscription } from './types.js';

export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export function isValidFcmToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 64 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}

// APNs device tokens are 32 bytes today, sent as hex; Apple says not to rely
// on the length, so allow some room.
export function isValidApnsToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64,200}$/.test(value);
}

export function isValidApnsEnvironment(value: unknown): value is 'production' | 'sandbox' {
  return value === 'production' || value === 'sandbox';
}

// UnifiedPush endpoints point at whatever distributor server the user chose
// (ntfy.sh, a self-hosted ntfy, NextPush, ...) so unlike Web Push there is no
// short allowlist of origins - but they must still be https and sanely sized.
export function isValidUnifiedPushEndpoint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 10 &&
    value.length <= 2048 &&
    /^https:\/\//i.test(value)
  );
}

// Web Push keys as delivered by the UnifiedPush connector; same shape and
// limits as a browser subscription's `keys`.
export function isValidUnifiedPushKeys(
  value: unknown,
): value is { p256dh: string; auth: string } {
  if (!value || typeof value !== 'object') return false;
  const keys = value as Record<string, unknown>;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 64 || keys.p256dh.length > 256) {
    return false;
  }
  if (typeof keys.auth !== 'string' || keys.auth.length < 16 || keys.auth.length > 64) {
    return false;
  }
  return true;
}

// Browser PushSubscription endpoints come from the major push services
// (FCM, Mozilla autopush, Apple, WindowsNotificationServices). Allow only
// https URLs and cap the length so a malicious caller can't bloat the store.
export function isValidWebPushSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.endpoint !== 'string') return false;
  if (v.endpoint.length < 10 || v.endpoint.length > 2048) return false;
  if (!/^https:\/\//i.test(v.endpoint)) return false;
  if (!v.keys || typeof v.keys !== 'object') return false;
  const keys = v.keys as Record<string, unknown>;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 64 || keys.p256dh.length > 256) {
    return false;
  }
  if (typeof keys.auth !== 'string' || keys.auth.length < 16 || keys.auth.length > 64) {
    return false;
  }
  return true;
}
