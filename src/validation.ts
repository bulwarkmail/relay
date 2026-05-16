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
