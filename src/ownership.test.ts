// A client may bind its record to a secret of its own when it first registers the id.
// From then on the id alone neither replaces the record, deletes it, reads its
// verification code nor pushes through it. A record registered without a secret,
// which is what every webmail and app released so far does, works by its id alone
// exactly as before.
//
// On the wire:
//   - each register route takes an optional `secret`, 32 to 128 characters of
//     [A-Za-z0-9_-]; any other value there is 400 and nothing is stored
//   - only an id of 40 characters or more takes a secret (released clients use 32 hex
//     digits); a shorter one, or an id registered without a secret, answers 409
//   - DELETE /api/push/register/:id and GET /api/push/verify/:id take the secret as
//     `Authorization: Bearer <secret>`, POST /api/push/jmap/:id as `?k=<secret>`
//   - GET /api/push/active/:id stays open
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  apnsKeyPem,
  emailPush,
  makeDevice,
  newId,
  postJson,
  pushVerification,
  seedStore,
  serviceAccount,
  startFakeApns,
  startFakePushService,
  startRelay,
  storedRecords,
  type FakeApns,
  type FakePushService,
  type RunningRelay,
} from './test-support/harness.js';

let service: FakePushService;
let apns: FakeApns;
let relay: RunningRelay;
const projectId = 'owner-project';
const fcmSend = `/v1/projects/${projectId}/messages:send`;

const nativeEnv = () => ({
  APNS_KEY: apnsKeyPem(),
  APNS_KEY_ID: 'KEYID12345',
  APNS_TEAM_ID: 'TEAM123456',
  APNS_ORIGIN: apns.origin,
  FCM_ORIGIN: service.url('').replace(/\/$/, ''),
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount(projectId, service.url('/oauth/token'))),
});

before(async () => {
  service = await startFakePushService();
  apns = await startFakeApns();
  service.answer('/oauth/token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }) });
  service.answer(fcmSend, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  relay = await startRelay({ env: nativeEnv() });
});

after(async () => {
  await relay.stop();
  await apns.close();
  await service.close();
});

// Obviously fake values, of the shape a client would generate.
const SECRET = 'fake-owner-secret-0123456789abcdefghijklm';
const OTHER_SECRET = 'fake-other-secret-0123456789abcdefghijklm';

/** An id of the form a client that sends a secret uses: 32 random bytes, base64url. */
const longId = () => crypto.randomBytes(32).toString('base64url');

async function call(base: string, pathname: string, method: string, options: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
      ...options.headers,
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const del = (id: string, bearer?: string, base = relay.base) => call(base, `/api/push/register/${id}`, 'DELETE', { bearer });
const poll = (id: string, bearer?: string, base = relay.base) => call(base, `/api/push/verify/${id}`, 'GET', { bearer });
const active = (id: string, base = relay.base) => call(base, `/api/push/active/${id}`, 'GET');

async function registerWithSecret(pathname: string, id = longId(), secret = SECRET) {
  const device = makeDevice();
  const res = await postJson(relay.base, '/api/push/register/web', {
    subscriptionId: id,
    subscription: { endpoint: service.url(pathname), keys: device.keys },
    accountLabel: 'alice@example.org',
    secret,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id, device };
}

describe('a record registered with a secret', () => {
  it('is not replaced on any route by a registration without that secret', async () => {
    const { id } = await registerWithSecret('/owned');
    for (const [route, body] of [
      ['/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/taker'), keys: makeDevice().keys } }],
      ['/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/taker'), keys: makeDevice().keys }, secret: OTHER_SECRET }],
      ['/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/taker') }],
      ['/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/taker'), secret: OTHER_SECRET }],
      ['/api/push/register', { subscriptionId: id, fcmToken: 'f'.repeat(100) }],
      ['/api/push/register', { subscriptionId: id, fcmToken: 'f'.repeat(100), secret: OTHER_SECRET }],
      ['/api/push/register/apns', { subscriptionId: id, deviceToken: 'ab'.repeat(32), environment: 'production' }],
      ['/api/push/register/apns', { subscriptionId: id, deviceToken: 'ab'.repeat(32), environment: 'production', secret: OTHER_SECRET }],
    ] as const) {
      const res = await postJson(relay.base, route, body);
      assert.equal(res.status, 403, `${route} answered ${res.status}`);
    }
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${SECRET}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(service.to('/owned').length, 1, 'the push went somewhere else');
    assert.equal(service.to('/taker').length, 0);
  });

  it('is replaced by a registration with its secret, also one that changes the transport', async () => {
    const { id } = await registerWithSecret('/owned-web');
    const again = await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/owned-web-2'), keys: makeDevice().keys }, secret: SECRET });
    assert.equal(again.status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${SECRET}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(service.to('/owned-web-2').length, 1);
    // Web Push to UnifiedPush: the record stays the owner's.
    const moved = await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/owned-up'), secret: SECRET });
    assert.equal(moved.status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']))).status, 403, 'the secret did not carry over');
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${SECRET}`, emailPush('a', ['e3']))).status, 200);
    assert.equal(service.to('/owned-up').length, 1);
    assert.equal((await del(id)).status, 403);
    assert.equal((await del(id, SECRET)).status, 200);
  });

  it('is deleted only with its secret in the Authorization header', async () => {
    const { id } = await registerWithSecret('/owned-delete');
    assert.equal((await del(id)).status, 403);
    assert.equal((await del(id, OTHER_SECRET)).status, 403);
    // In the query instead of the header: refused like a missing one.
    assert.equal((await call(relay.base, `/api/push/register/${id}?k=${SECRET}`, 'DELETE')).status, 403);
    assert.equal((await call(relay.base, `/api/push/register/${id}`, 'DELETE', { headers: { authorization: SECRET } })).status, 403);
    assert.deepEqual((await active(id)).body, { active: true }, 'other devices may still ask about it');
    assert.equal((await del(id, SECRET)).status, 200);
    assert.equal((await active(id)).status, 404);
  });

  it('gives its verification code only to a poll with its secret, and a refused poll changes nothing', async () => {
    const { id } = await registerWithSecret('/owned-verify');
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${SECRET}`, pushVerification('the-code'))).status, 200);
    for (const attempt of [poll(id), poll(id, OTHER_SECRET), call(relay.base, `/api/push/verify/${id}?k=${SECRET}`, 'GET')]) {
      const refused = await attempt;
      assert.equal(refused.status, 403);
      assert.ok(!JSON.stringify(refused.body).includes('the-code'));
    }
    assert.equal(storedRecords(relay.dataDir)[id].codeCollectedAt, undefined, 'a refused poll marked the code as collected');
    assert.deepEqual((await poll(id, SECRET)).body, { verificationCode: 'the-code' });
    assert.ok(storedRecords(relay.dataDir)[id].codeCollectedAt);
  });

  it('takes pushes and codes only on the URL with its secret, decoded, given once', async () => {
    const { id } = await registerWithSecret('/owned-push');
    const refusedTargets = [
      `/api/push/jmap/${id}`,
      `/api/push/jmap/${id}?k=${OTHER_SECRET}`,
      `/api/push/jmap/${id}?k=`,
      `/api/push/jmap/${id}?k=${SECRET}x`,
      `/api/push/jmap/${id}?k=${SECRET}&k=${SECRET}`,
      `/api/push/jmap/${id}?key=${SECRET}`,
    ];
    for (const target of refusedTargets) {
      for (const body of [emailPush('a', ['forged']), pushVerification('forged-code')]) {
        const res = await postJson(relay.base, target, body);
        assert.equal(res.status, 403, `${target.replace(id, '<id>')} answered ${res.status}`);
      }
    }
    // The header belongs to the other routes: on the push URL it counts for nothing.
    assert.equal((await call(relay.base, `/api/push/jmap/${id}`, 'POST', { bearer: SECRET, body: emailPush('a', ['forged']) })).status, 403);
    assert.equal(service.to('/owned-push').length, 0, 'something reached the device');
    assert.deepEqual((await poll(id, SECRET)).body, { verificationCode: null }, 'a refused push stored a code');
    // A percent-encoded character is the character it stands for.
    const encoded = SECRET.replace('-', '%2D');
    assert.notEqual(encoded, SECRET);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${encoded}`, emailPush('a', ['e1']))).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?other=1&k=${SECRET}`, emailPush('a', ['e2']))).status, 200);
    assert.equal(service.to('/owned-push').length, 2);
  });

  it('is not made from a secret of the wrong shape, on any route', async () => {
    const bodies = (id: string, secret: unknown) => [
      ['/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/bad-secret'), keys: makeDevice().keys }, secret }],
      ['/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/bad-secret'), secret }],
      ['/api/push/register', { subscriptionId: id, fcmToken: 'f'.repeat(100), secret }],
      ['/api/push/register/apns', { subscriptionId: id, deviceToken: 'ab'.repeat(32), environment: 'production', secret }],
    ] as const;
    for (const secret of ['too-short', 'x'.repeat(129), 'spaces are not part of a secret, however long it is', 'ünïcödé'.repeat(6), '+'.repeat(40), 12345678901234567890123456789012, null, true, [SECRET], { value: SECRET }]) {
      for (const [route, body] of bodies(longId(), secret)) {
        const res = await postJson(relay.base, route, body);
        assert.equal(res.status, 400, `${route} with secret ${JSON.stringify(secret)} answered ${res.status}`);
        assert.equal((await active(body.subscriptionId)).status, 404, 'something was stored');
      }
    }
  });

  it('keeps no usable secret on disk or in the logs, and stays bound after a restart', async () => {
    const own = await startRelay();
    let again: RunningRelay | null = null;
    try {
      const id = longId();
      const unknown = longId();
      assert.equal((await postJson(own.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/owned-store'), keys: makeDevice().keys }, secret: SECRET })).status, 200);
      await postJson(own.base, `/api/push/jmap/${id}?k=${SECRET}`, emailPush('a', ['e1']));
      await postJson(own.base, `/api/push/jmap/${id}?k=${OTHER_SECRET}`, emailPush('a', ['e2']));
      // The paths that answer early or fail.
      await postJson(own.base, `/api/push/jmap/${id}?k=${SECRET}`, '{not json');
      await postJson(own.base, `/api/push/jmap/${unknown}?k=${SECRET}`, emailPush('a', ['e3']));
      await call(own.base, `/api/push/register/${id}`, 'DELETE', { bearer: OTHER_SECRET });
      await call(own.base, `/api/push/verify/${id}`, 'GET', { bearer: OTHER_SECRET });
      await postJson(own.base, '/api/push/register/web', { subscriptionId: newId(), subscription: { endpoint: service.url('/owned-store'), keys: makeDevice().keys }, secret: SECRET });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const files = fs.readdirSync(own.dataDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
      assert.ok(files.length > 0, 'nothing was saved');
      for (const entry of files) {
        const content = fs.readFileSync(path.join(entry.parentPath ?? (entry as any).path, entry.name), 'latin1');
        assert.ok(!content.includes(SECRET), `${entry.name} holds the secret`);
        assert.ok(!content.includes(OTHER_SECRET), `${entry.name} holds a secret somebody tried`);
      }
      assert.ok(!own.logs().includes(SECRET), 'the logs hold the secret');
      assert.ok(!own.logs().includes(OTHER_SECRET), 'the logs hold a secret somebody tried');

      again = await own.restart();
      assert.equal((await del(id, undefined, again.base)).status, 403);
      assert.equal((await poll(id, undefined, again.base)).status, 403);
      assert.equal((await postJson(again.base, `/api/push/jmap/${id}`, emailPush('a', ['e4']))).status, 403);
      assert.equal((await postJson(again.base, `/api/push/jmap/${id}?k=${SECRET}`, emailPush('a', ['e5']))).status, 200);
      assert.equal((await poll(id, SECRET, again.base)).status, 200);
      assert.equal((await del(id, SECRET, again.base)).status, 200);
      assert.ok(!again.logs().includes(SECRET));
    } finally {
      await again?.stop();
      await own.stop();
    }
  });

  it('frees its id once it is deleted or has expired, for whoever registers next', async () => {
    // Deleted by its owner: the next registration decides, with or without a secret.
    const { id } = await registerWithSecret('/freed');
    assert.equal((await del(id, SECRET)).status, 200);
    assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/freed-next') })).status, 200);
    assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/freed-next'), secret: SECRET })).status, 409, 'a record without a secret took one');
    assert.equal((await del(id)).status, 200);

    // Expired while the relay was down: gone at the next start, and its secret with it.
    const day = 24 * 60 * 60 * 1000;
    const hash = crypto.createHash('sha256').update(OTHER_SECRET).digest('base64url');
    const neverUsed = longId();
    const longQuiet = longId();
    const recent = longId();
    const record = (pathname: string, at: number, lastPushAt: number | null) => ({
      kind: 'up', endpoint: service.url(pathname), keys: null, verificationCode: null,
      createdAt: at, lastRegisteredAt: at, lastPushAt, secretHash: hash,
    });
    const dataDir = seedStore({
      [neverUsed]: record('/expired-a', Date.now() - 8 * day, null),
      [longQuiet]: record('/expired-b', Date.now() - 200 * day, Date.now() - 91 * day),
      [recent]: record('/kept', Date.now() - day, null),
    });
    const own = await startRelay({ dataDir });
    try {
      assert.equal((await postJson(own.base, '/api/push/register/unifiedpush', { subscriptionId: neverUsed, endpoint: service.url('/expired-a2') })).status, 200);
      assert.equal((await postJson(own.base, '/api/push/register/unifiedpush', { subscriptionId: longQuiet, endpoint: service.url('/expired-b2'), secret: SECRET })).status, 200);
      // One that has not expired keeps its secret.
      assert.equal((await postJson(own.base, '/api/push/register/unifiedpush', { subscriptionId: recent, endpoint: service.url('/taken') })).status, 403);
      assert.equal((await del(recent, OTHER_SECRET, own.base)).status, 200);
    } finally {
      await own.stop();
    }
  });

  it('spends the address budget on a refused registration like on any other', async () => {
    const own = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '3', PUSH_REGISTER_REFILL_MS: '600000' } });
    try {
      const id = longId();
      const register = (secret: string | undefined, from: string) =>
        fetch(`${own.base}/api/push/register/unifiedpush`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
          body: JSON.stringify({ subscriptionId: id, endpoint: service.url('/budget'), ...(secret ? { secret } : {}) }),
        }).then((res) => res.status);
      assert.equal(await register(SECRET, '198.51.100.7'), 200);
      assert.equal(await register(undefined, '203.0.113.9'), 403);
      assert.equal(await register(OTHER_SECRET, '203.0.113.9'), 403);
      assert.equal(await register(undefined, '203.0.113.9'), 403);
      assert.equal(await register(SECRET, '203.0.113.9'), 429, 'refused registrations were free');
    } finally {
      await own.stop();
    }
  });
});

// Every webmail and app released so far registers 32 hex digits without a secret.
describe('a record registered without a secret', () => {
  it('works by its id alone, as before (browser)', async () => {
    const id = newId();
    const device = makeDevice();
    assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/plain'), keys: device.keys }, accountLabel: 'old@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('plain-code'))).status, 200);
    assert.deepEqual((await poll(id)).body, { verificationCode: 'plain-code' });
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(service.to('/plain').length, 1);
    assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/plain-2'), keys: device.keys } })).status, 200);
    assert.equal((await del(id)).status, 200);
  });

  it('works by its id alone, as before (Android app, FCM)', async () => {
    const id = newId();
    const token = 'f'.repeat(100);
    const sentBefore = service.to(fcmSend).length;
    assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: id, fcmToken: token, accountLabel: 'old@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('fcm-code'))).status, 200);
    assert.deepEqual((await poll(id)).body, { verificationCode: 'fcm-code' });
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(service.to(fcmSend).length, sentBefore + 1);
    assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: id, fcmToken: token, accountLabel: 'old@example.org' })).status, 200);
    assert.equal((await del(id)).status, 200);
  });

  it('works by its id alone, as before (iOS app, APNs)', async () => {
    const id = newId();
    const token = 'ab'.repeat(32);
    const sentBefore = apns.requests.length;
    assert.equal((await postJson(relay.base, '/api/push/register/apns', { subscriptionId: id, deviceToken: token, environment: 'production', accountLabel: 'old@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('apns-code'))).status, 200);
    assert.deepEqual((await poll(id)).body, { verificationCode: 'apns-code' });
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(apns.requests.length, sentBefore + 1);
    assert.equal((await postJson(relay.base, '/api/push/register/apns', { subscriptionId: id, deviceToken: token, environment: 'production' })).status, 200);
    assert.equal((await del(id)).status, 200);
  });

  const takeOver = (id: string, secret: string) => [
    ['/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/stranger'), keys: makeDevice().keys }, secret }],
    ['/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/stranger'), secret }],
    ['/api/push/register', { subscriptionId: id, fcmToken: 'f'.repeat(100), secret }],
    ['/api/push/register/apns', { subscriptionId: id, deviceToken: 'ab'.repeat(32), environment: 'production', secret }],
  ] as const;

  async function stillWorks(id: string, own: object, pathname: string) {
    assert.equal((await postJson(relay.base, '/api/push/register/web', own)).status, 200, 'the old client was locked out of its id');
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('old-code'))).status, 200);
    assert.deepEqual((await poll(id)).body, { verificationCode: 'old-code' });
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
    assert.equal(service.to(pathname).length, 1);
    assert.equal((await del(id)).status, 200);
  }

  it('cannot be bound to a secret by somebody else, on any route', async () => {
    const id = newId();
    const own = { subscriptionId: id, subscription: { endpoint: service.url('/old-client'), keys: makeDevice().keys } };
    assert.equal((await postJson(relay.base, '/api/push/register/web', own)).status, 200);
    for (const [route, body] of takeOver(id, OTHER_SECRET)) {
      const res = await postJson(relay.base, route, body);
      assert.equal(res.status, 409, `${route} answered ${res.status}`);
    }
    assert.equal(service.to('/stranger').length, 0);
    await stillWorks(id, own, '/old-client');
  });

  it('cannot be bound to a secret after somebody deleted it, or once it expired', async () => {
    const id = newId();
    const own = { subscriptionId: id, subscription: { endpoint: service.url('/old-client-2'), keys: makeDevice().keys } };
    assert.equal((await postJson(relay.base, '/api/push/register/web', own)).status, 200);
    // The id alone deletes a record without a secret, as it always has. The id is
    // free then, but an id of the released clients' form never takes a secret.
    assert.equal((await del(id)).status, 200);
    for (const [route, body] of takeOver(id, OTHER_SECRET)) {
      const res = await postJson(relay.base, route, body);
      assert.equal(res.status, 409, `${route} answered ${res.status}`);
      assert.equal((await active(id)).status, 404, `${route} stored a record`);
    }
    await stillWorks(id, own, '/old-client-2');
  });

  it('answers as before whatever query or Authorization header comes along', async () => {
    // A relay before secrets ignored both, and a mail server or proxy may add either.
    const id = newId();
    assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/plain-query'), keys: makeDevice().keys } })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=${OTHER_SECRET}&k=${SECRET}`, emailPush('a', ['e1']))).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}?k=nonsense`, emailPush('a', ['e2']))).status, 200);
    assert.equal(service.to('/plain-query').length, 2);
    assert.equal((await poll(id, OTHER_SECRET)).status, 200);
    assert.equal((await call(relay.base, `/api/push/verify/${id}`, 'GET', { headers: { authorization: 'Basic dXNlcjpwYXNz' } })).status, 200);
    assert.equal((await del(id, OTHER_SECRET)).status, 200);
  });
});

describe('a browser that sends the secret in a header', () => {
  it('is allowed to by the preflight', async () => {
    const res = await fetch(`${relay.base}/api/push/register/${longId()}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://mail.example.org', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization' },
    });
    assert.equal(res.status, 204);
    const allowed = (res.headers.get('access-control-allow-headers') ?? '').split(',').map((name) => name.trim().toLowerCase());
    assert.ok(allowed.includes('authorization'), `allowed: ${allowed.join(', ')}`);
    assert.ok(allowed.includes('content-type'));
  });
});
