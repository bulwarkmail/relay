import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forwardPolicy } from './forward-policy.js';
import type { SubscriptionRecord } from './types.js';

const record = (i: number): SubscriptionRecord => ({
  kind: 'web',
  webPush: { endpoint: `https://push.example.org/endpoint-${i}`, keys: { p256dh: 'p', auth: 'a' } },
  verificationCode: null,
  createdAt: 0,
  lastPushAt: null,
});

describe('backoffs the push services asked for', () => {
  it('keeps at most ten thousand endpoints, forgetting the one that went into backoff first', () => {
    const now = Date.now();
    const throttled = { ok: false, status: 429, unregistered: false, retryAfterSeconds: 3600 };
    for (let i = 0; i <= 10_000; i++) forwardPolicy.note(record(i), throttled, null, now);
    assert.equal(forwardPolicy.hold('first', record(0), now + 1000)?.reason, undefined, 'the oldest backoff is still kept');
    assert.equal(forwardPolicy.hold('second', record(1), now + 1000)?.reason, 'push-service-backoff');
    assert.equal(forwardPolicy.hold('last', record(10_000), now + 1000)?.reason, 'push-service-backoff');
  });
});
