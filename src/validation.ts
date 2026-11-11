import { isPublicEndpointUrl } from './endpoint-guard.js';
import type { WebPushSubscription } from './types.js';

// The names plain objects inherit. Never what a client generates, and a store or
// label keyed on one could reach the object prototype.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id) && !RESERVED_IDS.has(id);
}

// FCM registration tokens are an instance id, a colon and about 140 more
// characters, some 160 in all; this leaves six times that.
export function isValidFcmToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 64 &&
    value.length <= 1024 &&
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

const MAX_ENDPOINT_CHARS = 2048;
const MAX_LABEL_CHARS = 120;

// C0 and C1 controls, DEL included. The URL parser drops tabs and newlines
// anywhere and controls at either end, so what it hands back says nothing
// about what was sent.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The endpoint as the relay stores it: https, public (see endpoint-guard.ts) and
 * written the way the URL parser writes it. Null for anything else, for both the
 * browser push services and whichever distributor a UnifiedPush user chose.
 */
export function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10 || value.length > MAX_ENDPOINT_CHARS) return null;
  if (CONTROL_CHARACTER.test(value)) return null;
  let href: string;
  try {
    href = new URL(value).href;
  } catch {
    return null;
  }
  if (href.length > MAX_ENDPOINT_CHARS) return null;
  return isPublicEndpointUrl(href) ? href : null;
}

export function isValidUnifiedPushEndpoint(value: unknown): value is string {
  return normalizeEndpoint(value) !== null;
}

// Either base64 alphabet, padded or not, and nothing else: Buffer would skip
// any other character without a word.
const BASE64 = /^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/;

function decodeKey(value: unknown, maxChars: number): Buffer | null {
  if (typeof value !== 'string' || value.length > maxChars || !BASE64.test(value)) return null;
  return Buffer.from(value, 'base64');
}

/**
 * RFC 8291 keys: an uncompressed P-256 point and a 16-byte secret. Anything else
 * can't be encrypted to, and every later push would fail. Only the two keys are
 * kept, as the client sent them.
 */
export function normalizeKeys(value: unknown): { p256dh: string; auth: string } | null {
  if (!value || typeof value !== 'object') return null;
  const keys = value as Record<string, unknown>;
  const point = decodeKey(keys.p256dh, 256);
  const secret = decodeKey(keys.auth, 64);
  if (!point || point.length !== 65 || point[0] !== 4 || !secret || secret.length !== 16) return null;
  return { p256dh: keys.p256dh as string, auth: keys.auth as string };
}

// Web Push keys as delivered by the UnifiedPush connector; same shape and
// limits as a browser subscription's `keys`.
export function isValidUnifiedPushKeys(
  value: unknown,
): value is { p256dh: string; auth: string } {
  return normalizeKeys(value) !== null;
}

/** A browser's PushSubscriptionJSON reduced to what the relay sends with, or null. */
export function normalizeWebPushSubscription(value: unknown): WebPushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const endpoint = normalizeEndpoint(v.endpoint);
  const keys = normalizeKeys(v.keys);
  return endpoint && keys ? { endpoint, keys } : null;
}

// Controls, line and paragraph separators, and half of a surrogate pair. Emoji
// with joiners and other text a sign-in name can hold pass.
const NOT_PRINTABLE = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * The label to store: undefined when the client sent none, null when it sent
 * one that isn't printable text. Cut to 120 characters.
 */
export function accountLabelOf(value: unknown): string | undefined | null {
  if (typeof value !== 'string') return undefined;
  if (NOT_PRINTABLE.test(value)) return null;
  return value.slice(0, MAX_LABEL_CHARS);
}

// Stalwart sends 32 letters and digits. It ends up on disk and in a client's poll.
export function isValidVerificationCode(value: unknown): value is string {
  return typeof value === 'string' && /^[\x20-\x7e]{1,512}$/.test(value);
}
