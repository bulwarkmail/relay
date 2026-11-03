import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hostThrottleKey } from './forward-policy.js';
import {
  apnsKeyPem,
  emailPush,
  floodSent,
  getJson,
  makeDevice,
  newId,
  postJson,
  pushVerification,
  rawRequest,
  serviceAccount,
  startFakeApns,
  startFakePushService,
  startRelay,
  stateChange,
  testVapid,
  type FakeApns,
  type FakePushService,
  type RunningRelay,
} from './test-support/harness.js';

// Real relay process, real sockets, a local HTTPS server as the push service.
let service: FakePushService;
let relay: RunningRelay;

before(async () => {
  service = await startFakePushService();
  relay = await startRelay();
});

after(async () => {
  await relay.stop();
  await service.close();
});

function storedRecords(dataDir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'subscriptions.json'), 'utf8')).records;
}

async function registerWeb(pathname: string, target: RunningRelay = relay, label = 'alice@example.org') {
  const id = newId();
  const device = makeDevice();
  const res = await postJson(target.base, '/api/push/register/web', {
    subscriptionId: id,
    subscription: { endpoint: service.url(pathname), keys: device.keys },
    accountLabel: label,
  });
  assert.equal(res.status, 200);
  return { id, device };
}

describe('GET /api/health and /metrics', () => {
  it('reports the number of subscriptions', async () => {
    const before = (await getJson(relay.base, '/api/health')).body.subscriptions;
    await registerWeb('/health');
    const res = await getJson(relay.base, '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.subscriptions, before + 1);
  });

  it('serves Prometheus metrics with no subscription id or endpoint in them', async () => {
    const { id } = await registerWeb('/metrics-secret-path');
    await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
    const res = await fetch(`${relay.base}/metrics`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /relay_pushes_forwarded_total\{[^}]*transport="web"/);
    assert.ok(!text.includes(id));
    assert.ok(!text.includes('metrics-secret-path'));
  });
});

describe('GET /api/push/vapid-public-key', () => {
  it('returns the configured key', async () => {
    const res = await getJson(relay.base, '/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.publicKey, testVapid().VAPID_PUBLIC_KEY);
  });

  it('answers 503 on a relay without VAPID keys, and refuses Web Push registrations there', async () => {
    const bare = await startRelay({ vapid: false, env: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' } });
    try {
      assert.equal((await getJson(bare.base, '/api/push/vapid-public-key')).status, 503);
      const res = await postJson(bare.base, '/api/push/register/web', {
        subscriptionId: newId(),
        subscription: { endpoint: service.url('/no-vapid'), keys: makeDevice().keys },
      });
      assert.equal(res.status, 503);
    } finally {
      await bare.stop();
    }
  });
});

describe('POST /api/push/register/web', () => {
  it('accepts a browser subscription and starts without a verification code', async () => {
    const { id } = await registerWeb('/reg');
    assert.equal(storedRecords(relay.dataDir)[id].kind, 'web');
    const poll = await getJson(relay.base, `/api/push/verify/${id}`);
    assert.deepEqual(poll.body, { verificationCode: null });
  });

  it('drops an earlier code on re-registration, so a stale one is never read back', async () => {
    const { id, device } = await registerWeb('/reg-again');
    await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('old-code'));
    await postJson(relay.base, '/api/push/register/web', {
      subscriptionId: id,
      subscription: { endpoint: service.url('/reg-again'), keys: device.keys },
    });
    assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: null });
  });

  for (const [name, body] of [
    ['bad JSON', '{nope'],
    ['an empty body', ''],
    ['a short id', { subscriptionId: 'short', subscription: {} }],
    ['an id with slashes', { subscriptionId: 'aaaaaaaa/../bbbb', subscription: {} }],
    ['no keys', { subscriptionId: 'abcdefgh1', subscription: { endpoint: 'https://push.example.org/x' } }],
    ['plain http', { subscriptionId: 'abcdefgh1', subscription: { endpoint: 'http://push.example.org/x', keys: { p256dh: makeDevice().keys.p256dh, auth: makeDevice().keys.auth } } }],
    ['a non-string endpoint', { subscriptionId: 'abcdefgh1', subscription: { endpoint: 5, keys: {} } }],
  ] as const) {
    it(`answers 400 to ${name}`, async () => {
      assert.equal((await postJson(relay.base, '/api/push/register/web', body)).status, 400);
    });
  }
});

describe('POST /api/push/register/unifiedpush', () => {
  it('delivers encrypted Web Push when the connector gave keys', async () => {
    const id = newId();
    const device = makeDevice();
    const res = await postJson(relay.base, '/api/push/register/unifiedpush', {
      subscriptionId: id,
      endpoint: service.url('/up-keys'),
      keys: device.keys,
      accountLabel: 'bob@example.org',
    });
    assert.equal(res.status, 200);
    await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('c', ['e9']));
    const sent = service.to('/up-keys')[0];
    assert.equal(sent.headers['content-encoding'], 'aes128gcm');
    assert.deepEqual(JSON.parse(device.decrypt(sent.body)).emailIds, ['e9']);
  });

  it('posts the plain ping for a legacy distributor without keys', async () => {
    const id = newId();
    await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/up-plain') });
    const res = await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ c: { EmailDelivery: 's1' } }));
    assert.deepEqual(res.body, { ok: true });
    const sent = service.to('/up-plain')[0];
    assert.equal(sent.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(sent.body.toString()).kind, 'jmap-state-change');
  });

  it('works on a relay without VAPID keys', async () => {
    const bare = await startRelay({ vapid: false, env: { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' } });
    try {
      const id = newId();
      const device = makeDevice();
      await postJson(bare.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/up-novapid'), keys: device.keys });
      const res = await postJson(bare.base, `/api/push/jmap/${id}`, emailPush('c', ['e1']));
      assert.deepEqual(res.body, { ok: true });
      assert.equal(service.to('/up-novapid')[0].headers.authorization, undefined);
    } finally {
      await bare.stop();
    }
  });

  for (const [name, body] of [
    ['bad JSON', '{nope'],
    ['plain http', { subscriptionId: 'abcdefgh1', endpoint: 'http://ntfy.example.org/x' }],
    ['bad keys', { subscriptionId: 'abcdefgh1', endpoint: 'https://ntfy.example.org/x', keys: { p256dh: 'short', auth: 'short' } }],
  ] as const) {
    it(`answers 400 to ${name}`, async () => {
      assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', body)).status, 400);
    });
  }
});

describe('POST /api/push/register (FCM)', () => {
  it('answers 503 on a relay without Firebase credentials', async () => {
    const res = await postJson(relay.base, '/api/push/register', { subscriptionId: newId(), fcmToken: 'a'.repeat(100) });
    assert.equal(res.status, 503);
  });
});

describe('POST /api/push/register/apns', () => {
  it('answers 503 on a relay without an APNs key', async () => {
    const res = await postJson(relay.base, '/api/push/register/apns', { subscriptionId: newId(), deviceToken: 'ab'.repeat(32), environment: 'production' });
    assert.equal(res.status, 503);
  });
});

describe('APNs and FCM against fakes', () => {
  let apns: FakeApns;
  let native: RunningRelay;
  const projectId = 'audit-project';

  before(async () => {
    apns = await startFakeApns();
    // FCM is reached through the service account's token_uri and FCM_ORIGIN.
    service.answer('/oauth/token', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }),
    });
    native = await startRelay({
      env: {
        APNS_KEY: apnsKeyPem(),
        APNS_KEY_ID: 'KEYID12345',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_ORIGIN: apns.origin,
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount(projectId, service.url('/oauth/token'))),
      },
    });
  });

  after(async () => {
    await native.stop();
    await apns.close();
  });

  it('answers 400 to bad FCM input', async () => {
    assert.equal((await postJson(native.base, '/api/push/register', '{nope')).status, 400);
    assert.equal((await postJson(native.base, '/api/push/register', { subscriptionId: 'abcdefgh1', fcmToken: 'short' })).status, 400);
    assert.equal((await postJson(native.base, '/api/push/register', { subscriptionId: 'x', fcmToken: 'a'.repeat(100) })).status, 400);
  });

  it('sends APNs a content-blind alert with the ids', async () => {
    const id = newId();
    const token = 'ab'.repeat(32);
    assert.equal((await postJson(native.base, '/api/push/register/apns', { subscriptionId: id, deviceToken: token, environment: 'sandbox', accountLabel: 'a@b' })).status, 200);
    const res = await postJson(native.base, `/api/push/jmap/${id}`, {
      ...emailPush('d', ['e7']),
      emails: [{ id: 'e7', subject: 'SECRET SUBJECT', from: [{ email: 'SECRET@FROM' }] }],
    });
    assert.deepEqual(res.body, { ok: true });
    const sent = apns.requests.at(-1)!;
    assert.equal(sent.path, `/3/device/${token}`);
    assert.equal(sent.headers['apns-push-type'], 'alert');
    assert.ok(!sent.body.includes('SECRET'));
    assert.deepEqual(JSON.parse(sent.body).body.emailIds, ['e7']);
  });

  it('removes an APNs record on 410 and on BadDeviceToken', async () => {
    for (const [status, body] of [[410, '{"reason":"Unregistered"}'], [400, '{"reason":"BadDeviceToken"}']] as const) {
      const id = newId();
      await postJson(native.base, '/api/push/register/apns', { subscriptionId: id, deviceToken: 'cd'.repeat(32), environment: 'production' });
      apns.answer(status, body);
      await postJson(native.base, `/api/push/jmap/${id}`, emailPush('d', ['e8']));
      assert.equal((await getJson(native.base, `/api/push/verify/${id}`)).status, 404);
    }
    apns.answer(200);
  });

  it('sends FCM a data message with only ids and removes the record on UNREGISTERED', async () => {
    const id = newId();
    const token = 'f'.repeat(100);
    const send = `/v1/projects/${projectId}/messages:send`;
    service.answer(send, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal((await postJson(native.base, '/api/push/register', { subscriptionId: id, fcmToken: token, accountLabel: 'a@b' })).status, 200);
    const res = await postJson(native.base, `/api/push/jmap/${id}`, {
      ...emailPush('d', ['e5']),
      emails: [{ id: 'e5', subject: 'SECRET SUBJECT' }],
    });
    assert.deepEqual(res.body, { ok: true });
    const sent = service.to(send).at(-1)!;
    assert.equal(sent.headers.authorization, 'Bearer fake-access-token');
    const message = JSON.parse(sent.body.toString()).message;
    assert.equal(message.token, token);
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.data.emailIds, '["e5"]');
    assert.ok(!sent.body.toString().includes('SECRET'));

    service.answer(send, { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"status":"UNREGISTERED","message":"gone"}}' });
    await postJson(native.base, `/api/push/jmap/${id}`, emailPush('d', ['e6']));
    assert.equal((await getJson(native.base, `/api/push/verify/${id}`)).status, 404);
  });
});

describe('DELETE /api/push/register/:id', () => {
  it('removes the record and is idempotent', async () => {
    const { id } = await registerWeb('/del');
    assert.equal((await getJson(relay.base, `/api/push/register/${id}`, 'DELETE')).status, 200);
    assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 404);
    assert.equal((await getJson(relay.base, `/api/push/register/${id}`, 'DELETE')).status, 200);
  });

  it('answers 400 to a bad id', async () => {
    assert.equal((await getJson(relay.base, '/api/push/register/bad', 'DELETE')).status, 400);
  });
});

describe('GET /api/push/verify/:id', () => {
  it('hands back the code the mail server posted', async () => {
    const { id } = await registerWeb('/verify');
    assert.deepEqual((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('code-1'))).body, { ok: true });
    assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: 'code-1' });
  });

  it('answers 404 for an unknown id and 400 for a bad one', async () => {
    assert.equal((await getJson(relay.base, `/api/push/verify/${newId()}`)).status, 404);
    assert.equal((await getJson(relay.base, '/api/push/verify/bad')).status, 400);
  });
});

describe('PushVerification bodies', () => {
  it('refuses a code that is not a short string, and keeps the good one', async () => {
    const { id } = await registerWeb('/verify-junk');
    await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('good'));
    for (const verificationCode of [undefined, 5, { a: 1 }, '', 'x'.repeat(1024)]) {
      const res = await postJson(relay.base, `/api/push/jmap/${id}`, { '@type': 'PushVerification', pushSubscriptionId: 'b', verificationCode });
      assert.equal(res.status, 400);
    }
    assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: 'good' });
  });
});

describe('GET /api/push/active/:id', () => {
  it('says active for a fresh record, 404 for an unknown id, 400 for a bad one', async () => {
    const { id } = await registerWeb('/active');
    assert.deepEqual((await getJson(relay.base, `/api/push/active/${id}`)).body, { active: true });
    assert.equal((await getJson(relay.base, `/api/push/active/${newId()}`)).status, 404);
    assert.equal((await getJson(relay.base, '/api/push/active/bad')).status, 400);
  });
});

describe('a quiet subscription', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function seed(records: Record<string, unknown>): string {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), JSON.stringify({ records }));
    return dataDir;
  }

  function webRecord(fields: Record<string, unknown>) {
    return {
      kind: 'web',
      webPush: { endpoint: service.url('/quiet'), keys: makeDevice().keys },
      verificationCode: null,
      createdAt: Date.now() - 30 * 60 * 1000,
      lastPushAt: null,
      ...fields,
    };
  }

  it('stays active once its client has picked up the verification code, across re-registration and restart', async () => {
    const id = newId();
    const own = await startRelay({ dataDir: seed({ [id]: webRecord({ verificationCode: 'code' }) }) });
    assert.deepEqual((await getJson(own.base, `/api/push/active/${id}`)).body, { active: false }, 'nobody has the code yet');
    await getJson(own.base, `/api/push/verify/${id}`);
    assert.deepEqual((await getJson(own.base, `/api/push/active/${id}`)).body, { active: true });
    await postJson(own.base, '/api/push/register/web', {
      subscriptionId: id,
      subscription: { endpoint: service.url('/quiet'), keys: makeDevice().keys },
    });
    const again = await own.restart();
    try {
      assert.deepEqual((await getJson(again.base, `/api/push/active/${id}`)).body, { active: true });
    } finally {
      await again.stop();
    }
  });

  it('still reads as dead when no code ever came and no push ever went out', async () => {
    const id = newId();
    const own = await startRelay({ dataDir: seed({ [id]: webRecord({}) }) });
    try {
      assert.deepEqual((await getJson(own.base, `/api/push/active/${id}`)).body, { active: false });
    } finally {
      await own.stop();
    }
  });

  it('is kept past 90 days while its client keeps registering', async () => {
    const alive = newId();
    const gone = newId();
    const own = await startRelay({
      dataDir: seed({
        [alive]: webRecord({ createdAt: Date.now() - 200 * DAY, lastRegisteredAt: Date.now() - DAY }),
        [gone]: webRecord({ createdAt: Date.now() - 91 * DAY }),
      }),
    });
    try {
      assert.equal((await getJson(own.base, `/api/push/verify/${alive}`)).status, 200);
      assert.equal((await getJson(own.base, `/api/push/verify/${gone}`)).status, 404);
    } finally {
      await own.stop();
    }
  });

  it('notes each registration without moving createdAt', async () => {
    const id = newId();
    const createdAt = Date.now() - 80 * DAY;
    const own = await startRelay({ dataDir: seed({ [id]: webRecord({ createdAt }) }) });
    try {
      await postJson(own.base, '/api/push/register/web', {
        subscriptionId: id,
        subscription: { endpoint: service.url('/quiet'), keys: makeDevice().keys },
      });
      const stored = storedRecords(own.dataDir)[id];
      assert.equal(stored.createdAt, createdAt);
      assert.ok(Date.now() - stored.lastRegisteredAt < 60_000);
    } finally {
      await own.stop();
    }
  });
});

describe('POST /api/push/jmap/:id', () => {
  it('forwards an EmailPush as ids only, whatever properties the server included', async () => {
    const { id, device } = await registerWeb('/jmap-email');
    const res = await postJson(relay.base, `/api/push/jmap/${id}`, {
      '@type': 'EmailPush',
      accountId: 'b',
      state: 's9',
      emails: [{ id: 'e1', threadId: 't1', subject: 'SECRET SUBJECT', from: [{ email: 'SECRET@FROM' }], preview: 'SECRET PREVIEW' }],
    });
    assert.deepEqual(res.body, { ok: true });
    const sent = service.to('/jmap-email')[0];
    assert.equal(sent.headers['content-encoding'], 'aes128gcm');
    assert.match(String(sent.headers.authorization), /^vapid t=/);
    const plain = device.decrypt(sent.body);
    assert.ok(!plain.includes('SECRET'));
    assert.deepEqual(JSON.parse(plain), {
      kind: 'jmap-email-push',
      accountLabel: 'alice@example.org',
      accountId: 'b',
      emailIds: ['e1'],
      changed: { b: { EmailDelivery: 's9' } },
    });
  });

  it('forwards a StateChange with every account in it', async () => {
    const { id, device } = await registerWeb('/jmap-state');
    const res = await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's1' }, b: { EmailDelivery: 's2' } }));
    assert.deepEqual(res.body, { ok: true });
    const plain = JSON.parse(device.decrypt(service.to('/jmap-state')[0].body));
    assert.deepEqual(Object.keys(plain.changed), ['a', 'b']);
  });

  it('answers 400 to a body it cannot use and 404 to an unknown id', async () => {
    const { id } = await registerWeb('/jmap-bad');
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, '{nope')).status, 400);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, {})).status, 400);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, { '@type': 'Nonsense' })).status, 400);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, { '@type': 'EmailPush', accountId: 5, emails: [] })).status, 400);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${newId()}`, emailPush('a', ['e1']))).status, 404);
    assert.equal((await postJson(relay.base, '/api/push/jmap/bad', emailPush('a', ['e1']))).status, 400);
    assert.equal(service.to('/jmap-bad').length, 0);
  });

  it('removes the record when the push service says 404 or 410', async () => {
    for (const status of [404, 410]) {
      const pathname = `/gone-${status}`;
      service.answer(pathname, { status });
      const { id } = await registerWeb(pathname);
      const res = await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      assert.deepEqual(res.body, { ok: false });
      // Retrying a dead subscription gets nowhere.
      assert.equal(res.status, 200);
      assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 404);
      assert.ok(!(id in storedRecords(relay.dataDir)));
    }
  });

  it('asks the mail server to retry after a temporary failure, and keeps the record', async () => {
    for (const status of [429, 500, 502, 503]) {
      const pathname = `/temporary-${status}`;
      service.answer(pathname, { status });
      const { id } = await registerWeb(pathname);
      const res = await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      assert.ok(res.status >= 500, `service ${status} answered the server ${res.status}`);
      assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 200);
    }
  });

  it('asks the mail server to retry after a network error, and keeps the record', async () => {
    const id = newId();
    await postJson(relay.base, '/api/push/register/web', {
      subscriptionId: id,
      subscription: { endpoint: 'https://localhost:9/refused', keys: makeDevice().keys },
    });
    const res = await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's' } }));
    assert.ok(res.status >= 500);
    assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 200);
  });

  it('does not retry what will never work, and keeps the record', async () => {
    for (const status of [400, 401, 403, 413]) {
      const pathname = `/refused-${status}`;
      service.answer(pathname, { status });
      const { id } = await registerWeb(pathname);
      const res = await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: false });
      assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 200);
    }
  });
});

describe('malformed requests', () => {
  it('survives a request target that is not a URL', async () => {
    const answer = await rawRequest(relay.port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 400/);
    assert.equal(relay.exited(), false);
    assert.equal((await getJson(relay.base, '/api/health')).status, 200);
  });

  it('answers 400 to broken percent-encoding in an id', async () => {
    for (const pathname of ['/api/push/verify/%E0%A4%A', '/api/push/active/%E0%A4%A', '/api/push/register/%E0%A4%A']) {
      const method = pathname.includes('register') ? 'DELETE' : 'GET';
      assert.equal((await getJson(relay.base, pathname, method)).status, 400);
    }
    assert.equal((await postJson(relay.base, '/api/push/jmap/%E0%A4%A', emailPush('a', ['e1']))).status, 400);
  });
});

describe('oversized bodies', () => {
  it('answers 413 and leaves the relay working', async () => {
    const { id } = await registerWeb('/too-big');
    const big = 'x'.repeat(70 * 1024);
    for (const pathname of [`/api/push/jmap/${id}`, '/api/push/register/web']) {
      assert.equal((await postJson(relay.base, pathname, big)).status, 413);
    }
    assert.equal(service.to('/too-big').length, 0);
    assert.equal((await getJson(relay.base, '/api/health')).status, 200);
  });

  it('answers 413 to a body sent without a length', async () => {
    const size = 70 * 1024;
    const answer = await rawRequest(
      relay.port,
      `POST /api/push/register/web HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n${size.toString(16)}\r\n${'x'.repeat(size)}\r\n0\r\n\r\n`,
    );
    assert.match(answer, /^HTTP\/1\.1 413/);
  });
});

describe('a push still in flight', () => {
  const recordOf = (id: string) => storedRecords(relay.dataDir)[id];

  it('does not undo a registration that came in meanwhile', async () => {
    const pathname = '/race-register';
    service.answer(pathname, { status: 201, delayMs: 400 });
    const { id, device } = await registerWeb(pathname);
    const forward = postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await postJson(relay.base, '/api/push/register/web', {
      subscriptionId: id,
      subscription: { endpoint: service.url('/race-fresh'), keys: device.keys },
    });
    await forward;
    assert.equal(recordOf(id).webPush.endpoint, service.url('/race-fresh'));
  });

  it('does not bring back a record deleted meanwhile', async () => {
    const pathname = '/race-delete';
    service.answer(pathname, { status: 201, delayMs: 400 });
    const { id } = await registerWeb(pathname);
    const forward = postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await getJson(relay.base, `/api/push/register/${id}`, 'DELETE');
    await forward;
    assert.equal(recordOf(id), undefined);
    assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 404);
  });

  it('does not delete a registration whose new endpoint is fine when the old one comes back gone', async () => {
    const pathname = '/race-gone';
    service.answer(pathname, { status: 410, delayMs: 400 });
    const { id, device } = await registerWeb(pathname);
    const forward = postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await postJson(relay.base, '/api/push/register/web', {
      subscriptionId: id,
      subscription: { endpoint: service.url('/race-gone-fresh'), keys: device.keys },
    });
    await forward;
    assert.equal(recordOf(id)?.webPush.endpoint, service.url('/race-gone-fresh'));
  });
});

describe('a push service that never answers', () => {
  it('gives up before the mail server does, for every transport', async () => {
    const apns = await startFakeApns();
    apns.hang(true);
    const account = serviceAccount('hang-project', service.url('/oauth/hang-token'));
    service.answer('/oauth/hang-token', {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 't', expires_in: 3600 }),
    });
    service.answer('/v1/projects/hang-project/messages:send', { hang: true });
    service.answer('/hang-web', { hang: true });
    service.answer('/hang-up-keys', { hang: true });
    service.answer('/hang-up-plain', { hang: true });
    const own = await startRelay({
      env: {
        PUSH_FORWARD_TIMEOUT_MS: '400',
        APNS_KEY: apnsKeyPem(),
        APNS_KEY_ID: 'KEYID12345',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_ORIGIN: apns.origin,
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
      },
    });
    try {
      const registrations: [string, unknown][] = [
        ['/api/push/register/web', { subscription: { endpoint: service.url('/hang-web'), keys: makeDevice().keys } }],
        ['/api/push/register/unifiedpush', { endpoint: service.url('/hang-up-keys'), keys: makeDevice().keys }],
        ['/api/push/register/unifiedpush', { endpoint: service.url('/hang-up-plain') }],
        ['/api/push/register/apns', { deviceToken: 'ab'.repeat(32), environment: 'production' }],
        ['/api/push/register', { fcmToken: 'f'.repeat(100) }],
      ];
      for (const [route, fields] of registrations) {
        const id = newId();
        assert.equal((await postJson(own.base, route, { subscriptionId: id, ...(fields as object) })).status, 200);
        const started = Date.now();
        const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
        assert.ok(Date.now() - started < 5000, `${route} took ${Date.now() - started} ms`);
        assert.ok(res.status === 200 || res.status >= 500, `${route} answered ${res.status}`);
        assert.equal((await getJson(own.base, `/api/push/verify/${id}`)).status, 200, 'a timeout keeps the record');
      }
    } finally {
      await own.stop();
      await apns.close();
    }
  });
});

describe('endpoints the relay must not call', () => {
  const guarded = () => startRelay({ env: { PUSH_ALLOW_PRIVATE_ENDPOINTS: '' } });

  it('refuses private, loopback and metadata addresses at registration', async () => {
    const own = await guarded();
    try {
      for (const endpoint of [
        service.url('/ssrf'),
        'https://127.0.0.1/x',
        'https://[::1]/x',
        'https://169.254.169.254/latest/meta-data/',
        'https://10.0.0.1/x',
        'https://relay-test/x',
        'https://user:pw@push.example.org/x',
      ]) {
        const web = await postJson(own.base, '/api/push/register/web', { subscriptionId: newId(), subscription: { endpoint, keys: makeDevice().keys } });
        assert.equal(web.status, 400, `web ${endpoint}`);
        const up = await postJson(own.base, '/api/push/register/unifiedpush', { subscriptionId: newId(), endpoint });
        assert.equal(up.status, 400, `up ${endpoint}`);
      }
      assert.equal(service.to('/ssrf').length, 0);
    } finally {
      await own.stop();
    }
  });

  it('never calls a stored record that points somewhere private, and removes it', async () => {
    const web = newId();
    const up = newId();
    const plain = newId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'));
    const base = { verificationCode: null, createdAt: Date.now(), lastPushAt: null };
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), JSON.stringify({
      records: {
        [web]: { ...base, kind: 'web', webPush: { endpoint: service.url('/ssrf-web'), keys: makeDevice().keys } },
        [up]: { ...base, kind: 'up', endpoint: service.url('/ssrf-up'), keys: makeDevice().keys },
        [plain]: { ...base, kind: 'up', endpoint: service.url('/ssrf-plain'), keys: null },
      },
    }));
    const own = await startRelay({ dataDir, env: { PUSH_ALLOW_PRIVATE_ENDPOINTS: '' } });
    try {
      for (const id of [web, up, plain]) {
        const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: false });
        assert.equal((await getJson(own.base, `/api/push/verify/${id}`)).status, 404);
      }
      for (const pathname of ['/ssrf-web', '/ssrf-up', '/ssrf-plain']) assert.equal(service.to(pathname).length, 0, pathname);
    } finally {
      await own.stop();
    }
  });

  it('does not follow a redirect from a legacy UnifiedPush distributor', async () => {
    service.answer('/up-redirect', { status: 302, headers: { location: service.url('/redirected-inside') } });
    const id = newId();
    await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/up-redirect') });
    const res = await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's' } }));
    assert.deepEqual(res.body, { ok: false });
    assert.equal(service.to('/redirected-inside').length, 0);
  });

  it('refuses keys that cannot encrypt anything', async () => {
    for (const keys of [
      { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) },
      { p256dh: makeDevice().keys.p256dh, auth: 'y'.repeat(40) },
    ]) {
      const web = await postJson(relay.base, '/api/push/register/web', { subscriptionId: newId(), subscription: { endpoint: service.url('/bad-keys'), keys } });
      assert.equal(web.status, 400);
    }
  });
});

describe('sending politely', () => {
  it('passes the urgency the server asked for on an EmailPush and sends no Topic', async () => {
    const { id } = await registerWeb('/polite-email');
    const res = await fetch(`${relay.base}/api/push/jmap/${id}`, {
      method: 'POST',
      headers: { urgency: 'normal' },
      body: JSON.stringify(emailPush('a', ['e1'])),
    });
    assert.equal(res.status, 200);
    const sent = service.to('/polite-email')[0];
    assert.equal(sent.headers.urgency, 'normal');
    assert.equal(sent.headers.topic, undefined);
  });

  it('sends new mail on the state-change path at high urgency under one Topic per account', async () => {
    const { id } = await registerWeb('/polite-state');
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's1' } }));
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's2' } }));
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ b: { EmailDelivery: 's3' } }));
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's4' }, b: { EmailDelivery: 's5' } }));
    const [first, second, other, both] = service.to('/polite-state');
    assert.equal(first.headers.urgency, 'high');
    assert.match(String(first.headers.topic), /^[A-Za-z0-9_-]{1,32}$/);
    assert.equal(second.headers.topic, first.headers.topic);
    assert.notEqual(other.headers.topic, first.headers.topic);
    // A device that was offline must not lose one of the two accounts to a replacement.
    assert.equal(both.headers.topic, undefined);
  });

  it('sends other state pings at low urgency', async () => {
    const { id } = await registerWeb('/polite-low');
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { Email: 's1', Mailbox: 's2' } }));
    assert.equal(service.to('/polite-low')[0].headers.urgency, 'low');
  });

  it('keeps UnifiedPush distributors out of Topic, as they may not know it', async () => {
    const id = newId();
    await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/polite-up'), keys: makeDevice().keys });
    await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's1' } }));
    const sent = service.to('/polite-up')[0];
    assert.equal(sent.headers.urgency, 'high');
    assert.equal(sent.headers.topic, undefined);
  });

  it('holds back after a burst to one subscription, and lets it through again after the refill', async () => {
    const own = await startRelay({ env: { PUSH_SUBSCRIPTION_BURST: '3', PUSH_SUBSCRIPTION_REFILL_MS: '600' } });
    try {
      const { id } = await registerWeb('/polite-burst', own);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await postJson(own.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: `s${i}` } }));
        statuses.push(res.status);
        if (res.status === 429) assert.ok(Number(res.headers.get('retry-after')) >= 1);
      }
      assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      assert.equal(service.to('/polite-burst').length, 3, 'nothing went out while held');
      // A verification is never held: the client is waiting for it.
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, pushVerification('code'))).status, 200);
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 'later' } }))).status, 200);
      assert.equal(service.to('/polite-burst').length, 4);
    } finally {
      await own.stop();
    }
  });

  it('leaves a service alone for as long as its Retry-After says', async () => {
    const own = await startRelay();
    try {
      service.answer('/polite-429', { status: 429, headers: { 'retry-after': '120' } });
      const { id } = await registerWeb('/polite-429', own);
      const first = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      assert.equal(first.status, 503);
      assert.equal(first.headers.get('retry-after'), '120');
      const second = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']));
      assert.equal(second.status, 503);
      assert.equal(service.to('/polite-429').length, 1, 'the second push stayed here');
      assert.ok(Number(second.headers.get('retry-after')) <= 120);
      // Others on that service are not affected by one subscription's 429.
      const { id: other } = await registerWeb('/polite-other', own);
      assert.equal((await postJson(own.base, `/api/push/jmap/${other}`, emailPush('a', ['e3']))).status, 200);
      // A fresh registration is a fresh endpoint.
      service.answer('/polite-429', { status: 201 });
      await postJson(own.base, '/api/push/register/web', {
        subscriptionId: id,
        subscription: { endpoint: service.url('/polite-429'), keys: makeDevice().keys },
      });
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e4']))).status, 200);
    } finally {
      await own.stop();
    }
  });

  it('stops calling a service that throttles many subscriptions at once', async () => {
    const own = await startRelay({ env: { PUSH_HOST_THROTTLE_LIMIT: '3' } });
    try {
      for (let i = 0; i < 3; i++) {
        const pathname = `/polite-host-${i}`;
        service.answer(pathname, { status: 429 });
        const { id } = await registerWeb(pathname, own);
        assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 503);
      }
      const { id } = await registerWeb('/polite-host-healthy', own);
      const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']));
      assert.equal(res.status, 503);
      assert.equal(service.to('/polite-host-healthy').length, 0);
      const metrics = await (await fetch(`${own.base}/metrics`)).text();
      assert.match(metrics, /relay_pushes_held_total\{reason="push-service-throttle",transport="web"\} 1/);
    } finally {
      await own.stop();
    }
  });
});

describe('what the logs hold', () => {
  it('no subscription id, endpoint path, key, code or message property', async () => {
    const own = await startRelay();
    try {
      const device = makeDevice();
      const id = newId();
      service.answer('/log-secret-path', { status: 500, body: 'failed at https://service.example/log-secret-echo' });
      await postJson(own.base, '/api/push/register/web', {
        subscriptionId: id,
        subscription: { endpoint: service.url('/log-secret-path'), keys: device.keys },
        accountLabel: 'log-secret-label@example.org',
      });
      await postJson(own.base, `/api/push/jmap/${id}`, pushVerification('log-secret-code'));
      await getJson(own.base, `/api/push/verify/${id}`);
      await getJson(own.base, `/api/push/active/${id}`);
      await postJson(own.base, `/api/push/jmap/${id}`, {
        '@type': 'EmailPush',
        accountId: 'a',
        emails: [{ id: 'log-secret-id', subject: 'log-secret-subject' }],
      });
      const gone = await registerWeb('/log-gone-path', own);
      service.answer('/log-gone-path', { status: 410 });
      await postJson(own.base, `/api/push/jmap/${gone.id}`, emailPush('a', ['e1']));
      await getJson(own.base, `/api/push/register/${id}`, 'DELETE');
      await getJson(own.base, `/api/push/verify/${newId()}abc`);
      const logs = own.logs();
      assert.match(logs, /relay: push not delivered/);
      for (const secret of [id, gone.id, 'log-secret', 'log-gone-path', device.keys.p256dh, device.keys.auth]) {
        assert.ok(!logs.includes(secret), `logs hold ${secret}`);
      }
      // Still traceable: an operator can tell requests for one subscription apart.
      assert.match(logs, /"route":"\/api\/push\/jmap\/:id"/);
      assert.match(logs, /"subscription":"[0-9a-f]{12}"/);
    } finally {
      await own.stop();
    }
  });
});

describe('wrong methods', () => {
  it('answers 405 with Allow on a known path', async () => {
    for (const [pathname, method, allow] of [
      ['/api/push/register', 'GET', 'POST'],
      ['/api/push/register/web', 'PUT', 'POST'],
      ['/api/push/register/unifiedpush', 'DELETE', 'POST'],
      ['/api/push/register/apns', 'GET', 'POST'],
      ['/api/push/register/abcdefgh1', 'GET', 'DELETE'],
      ['/api/push/verify/abcdefgh1', 'POST', 'GET'],
      ['/api/push/active/abcdefgh1', 'DELETE', 'GET'],
      ['/api/push/jmap/abcdefgh1', 'GET', 'POST'],
      ['/api/push/vapid-public-key', 'POST', 'GET'],
      ['/api/health', 'POST', 'GET'],
      ['/metrics', 'POST', 'GET'],
    ] as const) {
      const res = await getJson(relay.base, pathname, method);
      assert.equal(res.status, 405, `${method} ${pathname}`);
      assert.equal(res.headers.get('allow'), `${allow}, OPTIONS`);
    }
  });
});

describe('ids that are names of object internals', () => {
  it('answers like any other unknown id and keeps running', async () => {
    const own = await startRelay();
    try {
      for (const id of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString']) {
        const verification = await postJson(own.base, `/api/push/jmap/${id}`, pushVerification('x'));
        assert.ok(verification.status === 404 || verification.status === 400, `${id}: ${verification.status}`);
        assert.ok([400, 404].includes((await getJson(own.base, `/api/push/verify/${id}`)).status), id);
        assert.ok([400, 404].includes((await getJson(own.base, `/api/push/active/${id}`)).status), id);
        assert.ok([200, 400].includes((await getJson(own.base, `/api/push/register/${id}`, 'DELETE')).status), id);
        const register = await postJson(own.base, '/api/push/register/web', {
          subscriptionId: id,
          subscription: { endpoint: service.url('/proto'), keys: makeDevice().keys },
        });
        assert.equal(register.status, 400, id);
      }
      assert.equal(own.exited(), false);
      assert.equal((await getJson(own.base, '/api/health')).status, 200);
      assert.equal((await fetch(`${own.base}/metrics`)).status, 200);
    } finally {
      await own.stop();
    }
  });

  it('keeps a record with such a name from an old store out of the object prototype', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), '{"records":{"__proto__":{"kind":"fcm","fcmToken":"x","verificationCode":"polluted","createdAt":1,"lastPushAt":null}}}');
    const own = await startRelay({ dataDir });
    try {
      assert.equal((await getJson(own.base, '/api/health')).status, 200);
      assert.equal((await getJson(own.base, `/api/push/verify/${newId()}`)).status, 404);
      assert.equal((await fetch(`${own.base}/metrics`)).status, 200);
    } finally {
      await own.stop();
    }
  });
});

describe('a push service that misbehaves on purpose', () => {
  it('gives up on an answer that keeps trickling, whatever the transport', async () => {
    const own = await startRelay({ env: { PUSH_FORWARD_TIMEOUT_MS: '400' } });
    try {
      for (const [pathname, route, fields] of [
        ['/drip-web', '/api/push/register/web', (url: string) => ({ subscription: { endpoint: url, keys: makeDevice().keys } })],
        ['/drip-up', '/api/push/register/unifiedpush', (url: string) => ({ endpoint: url, keys: makeDevice().keys })],
        ['/drip-plain', '/api/push/register/unifiedpush', (url: string) => ({ endpoint: url })],
      ] as const) {
        service.answer(pathname, { dripMs: 100 });
        const id = newId();
        await postJson(own.base, route, { subscriptionId: id, ...fields(service.url(pathname)) });
        const started = Date.now();
        const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
        assert.ok(Date.now() - started < 1500, `${pathname} took ${Date.now() - started} ms`);
        assert.ok(res.status === 503 || res.status === 200, `${pathname}: ${res.status}`);
      }
    } finally {
      await own.stop();
    }
  });

  it('does not read a huge answer into memory', async () => {
    const own = await startRelay();
    try {
      const total = 64 * 1024 * 1024;
      for (const [pathname, route, fields] of [
        ['/flood-web', '/api/push/register/web', (url: string) => ({ subscription: { endpoint: url, keys: makeDevice().keys } })],
        ['/flood-plain', '/api/push/register/unifiedpush', (url: string) => ({ endpoint: url })],
      ] as const) {
        service.answer(pathname, { floodBytes: total });
        floodSent.bytes = 0;
        const id = newId();
        await postJson(own.base, route, { subscriptionId: id, ...fields(service.url(pathname)) });
        const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
        assert.ok(res.status >= 500, `${pathname}: ${res.status}`);
        assert.ok(floodSent.bytes < total / 4, `${pathname} read ${floodSent.bytes} bytes`);
      }
      assert.equal(own.exited(), false);
    } finally {
      await own.stop();
    }
  });
});

describe('the native transports against a slow service', () => {
  it('opens a new APNs connection after one that stopped answering', async () => {
    const apns = await startFakeApns();
    apns.hang(true);
    const own = await startRelay({
      env: { PUSH_FORWARD_TIMEOUT_MS: '300', APNS_KEY: apnsKeyPem(), APNS_KEY_ID: 'KEYID12345', APNS_TEAM_ID: 'TEAM123456', APNS_ORIGIN: apns.origin },
    });
    try {
      const id = newId();
      await postJson(own.base, '/api/push/register/apns', { subscriptionId: id, deviceToken: 'ab'.repeat(32), environment: 'production' });
      assert.ok((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status >= 500);
      apns.hang(false);
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']))).status, 200);
      assert.equal(apns.sessionCount(), 2);
    } finally {
      await own.stop();
      await apns.close();
    }
  });

  it('keeps FCM within one deadline, token and send together', async () => {
    service.answer('/oauth/slow-token', {
      status: 200,
      delayMs: 300,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 't', expires_in: 3600 }),
    });
    service.answer('/v1/projects/slow-project/messages:send', { status: 200, delayMs: 300, body: '{}' });
    const own = await startRelay({
      env: {
        PUSH_FORWARD_TIMEOUT_MS: '500',
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount('slow-project', service.url('/oauth/slow-token'))),
      },
    });
    try {
      const id = newId();
      await postJson(own.base, '/api/push/register', { subscriptionId: id, fcmToken: 'f'.repeat(100) });
      assert.ok((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status >= 500);
    } finally {
      await own.stop();
    }
  });
});

describe('how far a throttle reaches', () => {
  it('does not let one Retry-After silence a whole host for long', async () => {
    const own = await startRelay({ env: { PUSH_HOST_THROTTLE_LIMIT: '2' } });
    try {
      for (let i = 0; i < 2; i++) {
        const pathname = `/reach-long-${i}`;
        service.answer(pathname, { status: 429, headers: { 'retry-after': '3600' } });
        const { id } = await registerWeb(pathname, own);
        await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      }
      const { id } = await registerWeb('/reach-other', own);
      const res = await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']));
      assert.equal(res.status, 503);
      assert.ok(Number(res.headers.get('retry-after')) <= 120, `held for ${res.headers.get('retry-after')} s`);
    } finally {
      await own.stop();
    }
  });

  it('takes many subscriptions on one endpoint for one, so nobody can provoke it for everyone', async () => {
    const own = await startRelay({ env: { PUSH_HOST_THROTTLE_LIMIT: '3' } });
    try {
      service.answer('/reach-same', { status: 429 });
      for (let i = 0; i < 5; i++) {
        const { id } = await registerWeb('/reach-same', own);
        assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 503);
      }
      const { id } = await registerWeb('/reach-bystander', own);
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']))).status, 200);
    } finally {
      await own.stop();
    }
  });

  it('keeps Web Push trouble away from native apps on the same host name', async () => {
    const account = serviceAccount('reach-project', service.url('/oauth/reach-token'));
    service.answer('/oauth/reach-token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 't', expires_in: 3600 }) });
    service.answer('/v1/projects/reach-project/messages:send', { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
    const own = await startRelay({
      env: {
        PUSH_HOST_THROTTLE_LIMIT: '2',
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
      },
    });
    try {
      assert.equal(hostThrottleKey({ kind: 'fcm' } as never, 'fcm.googleapis.com') === hostThrottleKey({ kind: 'web' } as never, 'fcm.googleapis.com'), false);
    } finally {
      await own.stop();
    }
  });

  it('does not put an old endpoint\'s 429 on the new one that replaced it', async () => {
    const own = await startRelay();
    try {
      service.answer('/reach-old', { status: 429, delayMs: 400, headers: { 'retry-after': '600' } });
      const { id, device } = await registerWeb('/reach-old', own);
      const forward = postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await postJson(own.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/reach-new'), keys: device.keys } });
      await forward;
      assert.equal((await postJson(own.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']))).status, 200);
      assert.equal(service.to('/reach-new').length, 1);
    } finally {
      await own.stop();
    }
  });
});

describe('a verification arriving during a registration', () => {
  it('is kept', async () => {
    const own = await startRelay();
    try {
      const { id, device } = await registerWeb('/slow-body', own);
      // Headers now, body later, as a slow network would.
      const body = JSON.stringify(pushVerification('slow-code'));
      const socket = net.connect(own.port, '127.0.0.1');
      await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
      socket.write(`POST /api/push/jmap/${id} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await postJson(own.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/slow-body'), keys: device.keys } });
      socket.resume();
      socket.write(body);
      await new Promise((resolve) => socket.once('close', resolve));
      assert.deepEqual((await getJson(own.base, `/api/push/verify/${id}`)).body, { verificationCode: 'slow-code' });
    } finally {
      await own.stop();
    }
  });
});

describe('anything else', () => {
  it('answers 404 on an unknown path and 204 to a preflight', async () => {
    assert.equal((await getJson(relay.base, '/nothing')).status, 404);
    const res = await fetch(`${relay.base}/api/push/register/web`, { method: 'OPTIONS', headers: { origin: 'https://mail.example.org' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /DELETE/);
  });

  it('serves the landing page', async () => {
    const res = await fetch(`${relay.base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Bulwark Push Relay/);
  });
});

describe('the store on disk', () => {
  const FILE = 'subscriptions.json';

  it('keeps a corrupt file aside and comes back from the previous version', async () => {
    const own = await startRelay();
    const { id: first } = await registerWeb('/store-1', own);
    const { id: second } = await registerWeb('/store-2', own);
    await own.stop();
    const file = path.join(own.dataDir, FILE);
    const intact = fs.readFileSync(file);
    assert.ok(fs.existsSync(`${file}.bak`), 'a previous version is kept');
    fs.writeFileSync(file, intact.subarray(0, intact.length - 20));
    const again = await startRelay({ dataDir: own.dataDir });
    try {
      assert.equal((await getJson(again.base, `/api/push/verify/${first}`)).status, 200);
      const aside = fs.readdirSync(own.dataDir).filter((name) => name.includes('corrupt'));
      assert.equal(aside.length, 1);
      assert.equal(fs.readFileSync(path.join(own.dataDir, aside[0])).length, intact.length - 20);
      assert.match(again.logs(), /"level":"error".*subscriptions/);
      // The newest write was only in the broken file; everything else is back.
      assert.equal((await getJson(again.base, `/api/push/verify/${second}`)).status, 404);
    } finally {
      await again.stop();
    }
  });

  it('never replaces a corrupt file when there is nothing to come back from', async () => {
    const own = await startRelay();
    const { id } = await registerWeb('/store-3', own);
    await own.stop();
    const file = path.join(own.dataDir, FILE);
    fs.rmSync(`${file}.bak`, { force: true });
    fs.writeFileSync(file, '{"records":{"oops');
    const again = await startRelay({ dataDir: own.dataDir });
    try {
      assert.equal((await getJson(again.base, `/api/push/verify/${id}`)).status, 404);
      await registerWeb('/store-4', again);
      const aside = fs.readdirSync(own.dataDir).filter((name) => name.includes('corrupt'));
      assert.equal(fs.readFileSync(path.join(own.dataDir, aside[0]), 'utf8'), '{"records":{"oops');
    } finally {
      await again.stop();
    }
  });

  it('starts from the previous version when the crash came between the two renames', async () => {
    const own = await startRelay();
    const { id } = await registerWeb('/store-5', own);
    await registerWeb('/store-6', own);
    await own.stop();
    fs.rmSync(path.join(own.dataDir, FILE));
    const again = await startRelay({ dataDir: own.dataDir });
    try {
      assert.equal((await getJson(again.base, `/api/push/verify/${id}`)).status, 200);
    } finally {
      await again.stop();
    }
  });

  it('survives many registrations at once', async () => {
    const own = await startRelay();
    const ids = Array.from({ length: 60 }, () => newId());
    const device = makeDevice();
    const answers = await Promise.all(ids.map((subscriptionId) => postJson(own.base, '/api/push/register/web', {
      subscriptionId,
      subscription: { endpoint: service.url('/store-many'), keys: device.keys },
    })));
    assert.ok(answers.every((res) => res.status === 200));
    const again = await own.restart();
    try {
      const records = storedRecords(own.dataDir);
      assert.ok(ids.every((id) => id in records));
      assert.equal((await getJson(again.base, '/api/health')).body.subscriptions, 60);
    } finally {
      await again.stop();
    }
  });
});

describe('starting up', () => {
  it('refuses to run on a store it cannot read, and leaves it alone', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'));
    // A read error other than "not there": a directory in the file's place.
    fs.mkdirSync(path.join(dataDir, 'subscriptions.json'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json', 'still-here'), 'x');
    await assert.rejects(startRelay({ dataDir }), /relay exited during start/);
    assert.ok(fs.existsSync(path.join(dataDir, 'subscriptions.json', 'still-here')));
  });

  it('has the store loaded before it takes any request', async () => {
    const seeded = newId();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), JSON.stringify({ records: { [seeded]: { kind: 'web', webPush: { endpoint: service.url('/seeded'), keys: makeDevice().keys }, verificationCode: null, createdAt: Date.now(), lastPushAt: null } } }));
    const own = await startRelay({ dataDir, skipHealthCheck: true });
    try {
      const ids = Array.from({ length: 40 }, () => newId());
      const device = makeDevice();
      const answers = await Promise.all(ids.map((subscriptionId) => postJson(own.base, '/api/push/register/web', {
        subscriptionId,
        subscription: { endpoint: service.url('/first-load'), keys: device.keys },
      })));
      assert.ok(answers.every((res) => res.status === 200));
      assert.equal((await getJson(own.base, '/api/health')).body.subscriptions, 41);
    } finally {
      await own.stop();
    }
  });
});

describe('restart', () => {
  it('keeps subscriptions and their codes', async () => {
    const own = await startRelay();
    const { id } = await registerWeb('/restart', own);
    await postJson(own.base, `/api/push/jmap/${id}`, pushVerification('kept'));
    const again = await own.restart();
    try {
      assert.deepEqual((await getJson(again.base, `/api/push/verify/${id}`)).body, { verificationCode: 'kept' });
    } finally {
      await again.stop();
    }
  });
});
