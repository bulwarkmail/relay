import { isPublicEndpointUrl } from './endpoint-guard.js';
import type { WebPushSubscription } from './types.js';

// The names plain objects inherit. Never what a client generates, and a store or
// label keyed on one could reach the object prototype.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) && !RESERVED_IDS.has(id);
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

// Sanely sized, https and public (see endpoint-guard.ts), for both the browser
// push services and whichever distributor server a UnifiedPush user chose.
function isValidEndpoint(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 10 &&
    value.length <= 2048 &&
    isPublicEndpointUrl(value)
  );
}

export function isValidUnifiedPushEndpoint(value: unknown): value is string {
  return isValidEndpoint(value);
}

// RFC 8291 keys: an uncompressed P-256 point and a 16-byte secret. Anything else
// can't be encrypted to, and every later push would fail. Buffer takes both
// base64 alphabets, with or without padding.
function isValidKeys(value: unknown): value is { p256dh: string; auth: string } {
  if (!value || typeof value !== 'object') return false;
  const keys = value as Record<string, unknown>;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length > 256) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length > 64) return false;
  const point = Buffer.from(keys.p256dh, 'base64url');
  return point.length === 65 && point[0] === 4 && Buffer.from(keys.auth, 'base64url').length === 16;
}

// Web Push keys as delivered by the UnifiedPush connector; same shape and
// limits as a browser subscription's `keys`.
export function isValidUnifiedPushKeys(
  value: unknown,
): value is { p256dh: string; auth: string } {
  return isValidKeys(value);
}

export function isValidWebPushSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isValidEndpoint(v.endpoint) && isValidKeys(v.keys);
}
