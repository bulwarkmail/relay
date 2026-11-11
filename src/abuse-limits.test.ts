// What the relay takes from callers it can't tell apart: how much one record may
// hold, how many records it keeps, how fast one client address may register, and
// what a change costs on a large store.
//
// Settings these tests rely on (README, "Limits"):
//   PUSH_MAX_SUBSCRIPTIONS     records the store takes; default 50,000; a new id past it gets 507
//   PUSH_REGISTER_BURST        registrations one client address may make at once; default 60
//   PUSH_REGISTER_REFILL_MS    time until that address may make one more; default 2,000
//   TRUST_PROXY                proxies in front of the relay; default 0. With 1 the client address is
//                              the last entry of X-Forwarded-For. With 0 and a loopback or private
//                              peer the relay cannot tell clients apart and applies no per-address limit.
// Seeded stores are written in the file format of the relay before this one: a new relay has to
// start on the file a running relay leaves behind.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  getJson,
  makeDevice,
  newId,
  postJson,
  pushVerification,
  startFakePushService,
  startRelay,
  storedRecords,
  type FakePushService,
} from './test-support/harness.js';

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

const known = async (relay: { base: string }, id: string) => (await getJson(relay.base, `/api/push/active/${id}`)).status === 200;

describe('what one registration may put into the store', () => {
  it('refuses an endpoint or keys padded with characters no client sends', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      const device = makeDevice();
      const pad = '\u0001'.repeat(200);
      const cases: Array<[string, unknown]> = [
        ['control characters in front of the endpoint', { endpoint: pad + service.url('/pad'), keys: device.keys }],
        ['a tab and a newline inside the endpoint', { endpoint: service.url('/pad').replace('/pad', '/p\ta\nd'), keys: device.keys }],
        ['p256dh padded with control characters', { endpoint: service.url('/pad'), keys: { p256dh: device.keys.p256dh + pad.slice(0, 100), auth: device.keys.auth } }],
        ['auth padded with control characters', { endpoint: service.url('/pad'), keys: { p256dh: device.keys.p256dh, auth: '\u0002'.repeat(20) + device.keys.auth } }],
        ['a C1 control inside the endpoint', { endpoint: service.url('/p\u0085ad'), keys: device.keys }],
        ['p256dh with a character outside base64', { endpoint: service.url('/pad'), keys: { p256dh: `${device.keys.p256dh.slice(0, 40)}.${device.keys.p256dh.slice(41)}`, auth: device.keys.auth } }],
        ['keys mixing both base64 alphabets', { endpoint: service.url('/pad'), keys: { p256dh: device.keys.p256dh, auth: `+${device.keys.auth.slice(1, 10)}-${device.keys.auth.slice(11)}` } }],
      ];
      for (const [what, subscription] of cases) {
        const id = newId();
        const web = await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription });
        assert.equal(web.status, 400, `web registration with ${what}`);
        const up = await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, ...(subscription as object) });
        assert.equal(up.status, 400, `UnifiedPush registration with ${what}`);
        assert.equal(await known(relay, id), false);
      }
      // What browsers send: base64url without padding, or base64 with it.
      const padded = { p256dh: Buffer.from(device.keys.p256dh, 'base64url').toString('base64'), auth: Buffer.from(device.keys.auth, 'base64url').toString('base64') };
      assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: newId(), subscription: { endpoint: service.url('/pad'), keys: device.keys } })).status, 200);
      assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: newId(), subscription: { endpoint: service.url('/pad'), keys: padded } })).status, 200);
    } finally {
      await relay.stop();
    }
  });

  it('keeps the endpoint as the URL parser writes it and nothing the client added', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      const device = makeDevice();
      const web = newId();
      const up = newId();
      const shouted = service.url('/Case/Kept').replace('https://localhost', 'HTTPS://LOCALHOST');
      assert.equal((await postJson(relay.base, '/api/push/register/web', {
        subscriptionId: web,
        subscription: { endpoint: shouted, expirationTime: null, keys: { ...device.keys, extra: 'x'.repeat(2000) }, extra: 'y'.repeat(2000) },
        accountLabel: 'alice@example.org',
        extra: 'z'.repeat(2000),
      })).status, 200);
      assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', {
        subscriptionId: up,
        endpoint: shouted,
        keys: { ...device.keys, extra: 'x'.repeat(2000) },
        extra: 'z'.repeat(2000),
      })).status, 200);
      const records = storedRecords(relay.dataDir);
      assert.deepEqual(records[web].webPush, { endpoint: service.url('/Case/Kept'), keys: device.keys });
      assert.equal(records[up].endpoint, service.url('/Case/Kept'));
      assert.deepEqual(records[up].keys, device.keys);
      assert.ok(!JSON.stringify(records).includes('xxxx') && !JSON.stringify(records).includes('yyyy') && !JSON.stringify(records).includes('zzzz'));
    } finally {
      await relay.stop();
    }
  });

  it('takes a label of printable text and nothing else', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      const register = (accountLabel: unknown) => postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: newId(), endpoint: service.url('/label'), accountLabel });
      for (const label of ['alice\u0000', 'ali\nce', 'alice\u0007', 'ali ce', 'ali\u0085ce', 'alice\ud800']) {
        assert.equal((await register(label)).status, 400, JSON.stringify(label));
      }
      for (const label of ['alice@example.org', 'Alice Example', 'Jörg 👨‍👩‍👧', 'x'.repeat(500)]) {
        assert.equal((await register(label)).status, 200, JSON.stringify(label));
      }
      const id = newId();
      await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/label'), accountLabel: 'x'.repeat(500) });
      assert.equal(storedRecords(relay.dataDir)[id].accountLabel.length, 120);
    } finally {
      await relay.stop();
    }
  });

  it('takes a verification code of printable ASCII up to 512 characters', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      const id = newId();
      await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/code') });
      for (const code of ['', 'code\n', 'code\u0000', 'cöde', 'c'.repeat(513), '\u0001'.repeat(10)]) {
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification(code))).status, 400, JSON.stringify(code));
      }
      const stalwart = 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dE';
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification(stalwart))).status, 200);
      assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: stalwart });
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('~'.repeat(512)))).status, 200);
    } finally {
      await relay.stop();
    }
  });
});
