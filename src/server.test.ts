import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  apnsKeyPem,
  emailPush,
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
    ['plain http', { subscriptionId: 'abcdefgh1', subscription: { endpoint: 'http://push.example.org/x', keys: { p256dh: 'x'.repeat(87), auth: 'y'.repeat(22) } } }],
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
  it('answers 400 to bad input', async () => {
    assert.equal((await postJson(relay.base, '/api/push/register', '{nope')).status, 400);
    assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: 'abcdefgh1', fcmToken: 'short' })).status, 400);
    assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: 'x', fcmToken: 'a'.repeat(100) })).status, 400);
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
      assert.equal((await getJson(relay.base, `/api/push/verify/${id}`)).status, 404);
      assert.ok(!(id in storedRecords(relay.dataDir)));
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
