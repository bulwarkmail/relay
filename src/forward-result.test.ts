import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyForward,
  failureReason,
  pushServiceHost,
  statusLabel,
} from './forward-result.js';
import type { SubscriptionRecord } from './types.js';

const base = { verificationCode: null, createdAt: 0, lastPushAt: null };

describe('classifyForward', () => {
  it('prefers unregistered over the status class', () => {
    assert.equal(classifyForward({ ok: false, status: 410, unregistered: true }), 'unregistered');
  });

  it('buckets failures by status class, and no response as fail', () => {
    assert.equal(classifyForward({ ok: true, status: 201, unregistered: false }), 'ok');
    assert.equal(classifyForward({ ok: false, status: 429, unregistered: false }), 'http-4xx');
    assert.equal(classifyForward({ ok: false, status: 503, unregistered: false }), 'http-5xx');
    assert.equal(classifyForward({ ok: false, status: 0, unregistered: false }), 'fail');
  });
});

describe('statusLabel', () => {
  it('uses the HTTP status, or none when nothing came back', () => {
    assert.equal(statusLabel(429), '429');
    assert.equal(statusLabel(0), 'none');
  });
});

describe('pushServiceHost', () => {
  it('returns only the host, never the endpoint path', () => {
    const web: SubscriptionRecord = {
      ...base,
      kind: 'web',
      webPush: {
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/secret-token',
        keys: { p256dh: 'p', auth: 'a' },
      },
    };
    const up: SubscriptionRecord = {
      ...base,
      kind: 'up',
      endpoint: 'https://ntfy.example.org/upSecretTopic?up=1',
      keys: null,
    };
    const fcm: SubscriptionRecord = { ...base, kind: 'fcm', fcmToken: 'token' };
    assert.equal(pushServiceHost(web), 'updates.push.services.mozilla.com');
    assert.equal(pushServiceHost(up), 'ntfy.example.org');
    assert.equal(pushServiceHost(fcm), 'fcm.googleapis.com');
  });
});

describe('failureReason', () => {
  it('prefers the push service body over the generic web-push message', () => {
    const error = Object.assign(new Error('Received unexpected response code'), {
      statusCode: 403,
      body: '{"reason":"BadJwtToken"}\n',
    });
    assert.equal(failureReason(error), '{"reason":"BadJwtToken"}');
  });

  it('adds the network error code from the cause', () => {
    const error = new Error('fetch failed', { cause: { code: 'ECONNRESET' } });
    assert.equal(failureReason(error), 'fetch failed (ECONNRESET)');
  });

  it('collapses whitespace, truncates long bodies and drops empty ones', () => {
    assert.equal(failureReason('<html>\n  <body>Too Many Requests</body>\n</html>'),
      '<html> <body>Too Many Requests</body> </html>');
    assert.equal(failureReason('x'.repeat(500))?.length, 201);
    assert.equal(failureReason('  '), undefined);
    assert.equal(failureReason(null), undefined);
  });
});
