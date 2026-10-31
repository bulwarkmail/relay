import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  apnsJwt,
  apnsPayload,
  classifyApnsResponse,
  resetApnsState,
  sendApnsPush,
  type ApnsConfig,
} from './apns.js';
import type { ApnsSubscriptionRecord, ForwardPayload } from './types.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const config: ApnsConfig = {
  keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  keyId: 'KEY1234567',
  teamId: 'TEAM123456',
  topic: 'org.bulwarkmail.mobile',
};

const payload: ForwardPayload = {
  kind: 'jmap-email-push',
  accountLabel: 'ada@example.org',
  accountId: 'c',
  emailIds: ['e1', 'e2'],
  changed: { c: { EmailDelivery: 's9' } },
};

const token = 'ab'.repeat(32);
const record: ApnsSubscriptionRecord = {
  kind: 'apns',
  deviceToken: token,
  environment: 'sandbox',
  verificationCode: null,
  createdAt: 0,
  lastPushAt: null,
};

describe('apnsPayload', () => {
  it('carries ids and a placeholder text, nothing about the message', () => {
    const body = apnsPayload(payload) as {
      aps: { alert: unknown; 'mutable-content': number; 'thread-id': string };
      body: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(body).sort(), ['aps', 'body']);
    assert.deepEqual(body.aps.alert, { title: 'Bulwark Mail', body: 'New message' });
    // The extension only runs for mutable notifications.
    assert.equal(body.aps['mutable-content'], 1);
    assert.equal(body.aps['thread-id'], 'c');
    assert.deepEqual(body.body, {
      kind: 'jmap-email-push',
      accountLabel: 'ada@example.org',
      accountId: 'c',
      emailIds: ['e1', 'e2'],
      changed: { c: { EmailDelivery: 's9' } },
    });
  });
});

describe('classifyApnsResponse', () => {
  it('accepts 200', () => {
    assert.deepEqual(classifyApnsResponse(200, ''), { ok: true, status: 200, unregistered: false, reason: undefined });
  });

  it('drops tokens APNs calls dead', () => {
    assert.equal(classifyApnsResponse(410, '{"reason":"Unregistered"}').unregistered, true);
    assert.equal(classifyApnsResponse(400, '{"reason":"BadDeviceToken"}').unregistered, true);
    assert.equal(classifyApnsResponse(400, '{"reason":"DeviceTokenNotForTopic"}').unregistered, true);
  });

  it('keeps the token for errors on our side', () => {
    const r = classifyApnsResponse(403, '{"reason":"ExpiredProviderToken"}');
    assert.equal(r.ok, false);
    assert.equal(r.unregistered, false);
    assert.equal(r.reason, 'ExpiredProviderToken');
    assert.equal(classifyApnsResponse(429, '{"reason":"TooManyRequests"}').unregistered, false);
  });
});

describe('apnsJwt', () => {
  beforeEach(() => resetApnsState(config));

  it('signs ES256 with the key id and team id', () => {
    const jwt = apnsJwt(config, 1_700_000_000_000);
    const [h, c, s] = jwt.split('.');
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
    assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: 'TEAM123456', iat: 1_700_000_000 });
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    assert.equal(valid, true);
  });

  it('reuses a token for 40 minutes, then signs a new one', () => {
    const first = apnsJwt(config, 1_700_000_000_000);
    assert.equal(apnsJwt(config, 1_700_000_000_000 + 39 * 60_000), first);
    assert.notEqual(apnsJwt(config, 1_700_000_000_000 + 41 * 60_000), first);
  });
});

describe('sendApnsPush', () => {
  let server: http2.Http2Server;
  let seen: { headers: http2.IncomingHttpHeaders; body: string } | null;
  let answer: { status: number; body: string };

  beforeEach(async () => {
    resetApnsState(config);
    seen = null;
    answer = { status: 200, body: '' };
    server = http2.createServer();
    server.on('stream', (stream, headers) => {
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => { body += chunk; });
      stream.on('end', () => {
        seen = { headers, body };
        stream.respond({ ':status': answer.status, 'content-type': 'application/json' });
        stream.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.APNS_ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    delete process.env.APNS_ORIGIN;
    resetApnsState(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts an alert push for the device token with the bearer token and topic', async () => {
    const result = await sendApnsPush(record, payload);
    assert.equal(result.ok, true);
    assert.ok(seen);
    assert.equal(seen.headers[':path'], `/3/device/${token}`);
    assert.equal(seen.headers['apns-topic'], 'org.bulwarkmail.mobile');
    assert.equal(seen.headers['apns-push-type'], 'alert');
    assert.match(String(seen.headers.authorization), /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    assert.deepEqual(JSON.parse(seen.body), apnsPayload(payload));
  });

  it('reports a removed app so the relay can drop the subscription', async () => {
    answer = { status: 410, body: '{"reason":"Unregistered"}' };
    const result = await sendApnsPush(record, payload);
    assert.equal(result.unregistered, true);
    assert.equal(result.status, 410);
  });

  it('fails without a key instead of sending', async () => {
    resetApnsState(null);
    const result = await sendApnsPush(record, payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(seen, null);
  });
});
