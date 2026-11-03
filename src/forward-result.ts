import type { SubscriptionRecord } from './types.js';

export type ForwardOutcome = 'ok' | 'unregistered' | 'http-4xx' | 'http-5xx' | 'fail';

// What a transport reports after trying to deliver one push. `status` is the
// push service's HTTP status, 0 when no response came back. `reason` is a
// short single-line explanation (the service's error body or the network
// error) for the failure log.
export interface SendResult {
  ok: boolean;
  status: number;
  unregistered: boolean;
  reason?: string;
  // The service's Retry-After, when it sent one.
  retryAfterSeconds?: number;
}

const MAX_REASON_CHARS = 200;

// How long one attempt at the push service may take. Stalwart's own request
// times out after 10 s and it tries again then, so a slower answer here would
// turn into the same push sent twice.
export function forwardTimeoutMs(): number {
  const configured = Number(process.env.PUSH_FORWARD_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 8000;
}

export function classifyForward(result: SendResult): ForwardOutcome {
  if (result.unregistered) return 'unregistered';
  if (result.ok) return 'ok';
  if (result.status >= 500) return 'http-5xx';
  if (result.status >= 400) return 'http-4xx';
  return 'fail';
}

// Worth another try, because the service itself says so or never answered. A
// non-2xx answer makes Stalwart try again a minute later (3 attempts by default),
// merging what arrived meanwhile into one push, and leave the subscription alone
// until then. Other refusals won't change a minute later.
export function isTemporaryFailure(result: SendResult): boolean {
  if (result.ok || result.unregistered) return false;
  return result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
}

// Metric label for the push service's answer. "none" covers network errors,
// timeouts and a relay without VAPID keys - nothing came back to look at.
export function statusLabel(status: number): string {
  return status > 0 ? String(status) : 'none';
}

// Only the host: Web Push and UnifiedPush endpoint paths are bearer
// capabilities and must not end up in logs.
export function pushServiceHost(record: SubscriptionRecord): string {
  if (record.kind === 'fcm') return 'fcm.googleapis.com';
  if (record.kind === 'apns') {
    return record.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  }
  const endpoint = record.kind === 'web' ? record.webPush.endpoint : record.endpoint;
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid-endpoint';
  }
}

// Turn a push service error body, a thrown error or plain text into one
// short log-friendly line. web-push's WebPushError carries the service's
// response body, which says far more than its generic message.
export function failureReason(error: unknown): string | undefined {
  let text = '';
  if (typeof error === 'string') {
    text = error;
  } else if (error instanceof Error) {
    const body = (error as { body?: unknown }).body;
    text = typeof body === 'string' && body.trim() ? body : error.message;
    const code =
      (error.cause as { code?: unknown } | undefined)?.code ??
      (error as { code?: unknown }).code;
    if (typeof code === 'string' && !text.includes(code)) text += ` (${code})`;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS)}…` : text;
}
