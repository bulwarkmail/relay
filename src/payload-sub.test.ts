// A device can hold several registrations (two logins, two servers, one browser
// with two accounts). Each forwarded push names the one it is for in `sub`: the
// first 16 bytes of SHA-256 over the subscription id, base64url. The id itself
// never goes out: the push service reads the payload on FCM, APNs and UnifiedPush
// without keys.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  apnsKeyPem,
  emailPush,
  makeDevice,
  newId,
  postJson,
  serviceAccount,
  startFakeApns,
  startFakePushService,
  startRelay,
  stateChange,
  type FakeApns,
  type FakePushService,
  type RunningRelay,
} from './test-support/harness.js';

const expectedSub = (id: string) => crypto.createHash('sha256').update(id).digest().subarray(0, 16).toString('base64url');
const FIVE_FIELDS = ['kind', 'accountLabel', 'accountId', 'emailIds', 'changed'];

let service: FakePushService;
let apns: FakeApns;
let relay: RunningRelay;
const projectId = 'sub-project';
const fcmSend = `/v1/projects/${projectId}/messages:send`;

before(async () => {
  service = await startFakePushService();
  apns = await startFakeApns();
  service.answer('/oauth/token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }) });
  service.answer(fcmSend, { status: 200, headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
  relay = await startRelay({
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
  await relay.stop();
  await apns.close();
  await service.close();
});

describe('the registration a push is for', () => {
  it('is named on a plain UnifiedPush ping, for both kinds of push, next to the fields clients read', async () => {
    const id = newId();
    assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/sub-plain'), accountLabel: 'a@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('acc', ['e1']))).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ acc: { EmailDelivery: 's2' } }))).status, 200);
    const sent = service.to('/sub-plain').map((request) => request.body.toString());
    assert.equal(sent.length, 2);
    for (const text of sent) {
      const payload = JSON.parse(text);
      assert.equal(payload.sub, expectedSub(id));
      for (const field of FIVE_FIELDS) assert.ok(field in payload, `${field} is missing`);
      assert.ok(!text.includes(id), 'the payload carries the id');
    }
  });

  it('is in the FCM data, as a string, and in the APNs body, never as the id', async () => {
    const fcmId = newId();
    assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: fcmId, fcmToken: 'f'.repeat(100), accountLabel: 'a@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${fcmId}`, emailPush('acc', ['e1']))).status, 200);
    const fcm = service.to(fcmSend).at(-1)!.body.toString();
    const data = JSON.parse(fcm).message.data;
    assert.equal(data.sub, expectedSub(fcmId));
    for (const value of Object.values(data)) assert.equal(typeof value, 'string', 'FCM takes strings only');
    assert.ok(!fcm.includes(fcmId));

    const apnsId = newId();
    assert.equal((await postJson(relay.base, '/api/push/register/apns', { subscriptionId: apnsId, deviceToken: 'ab'.repeat(32), environment: 'production', accountLabel: 'a@example.org' })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${apnsId}`, stateChange({ acc: { EmailDelivery: 's3' } }))).status, 200);
    const sent = apns.requests.at(-1)!.body;
    assert.equal(JSON.parse(sent).body.sub, expectedSub(apnsId));
    assert.ok(!sent.includes(apnsId));
  });

  it('is in the encrypted Web Push and UnifiedPush payloads, and tells two accounts on one endpoint apart', async () => {
    const device = makeDevice();
    const first = newId();
    const second = newId();
    for (const id of [first, second]) {
      assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/sub-web'), keys: device.keys } })).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('acc', ['e1']))).status, 200);
    }
    const subs = service.to('/sub-web').map((request) => JSON.parse(device.decrypt(request.body)).sub);
    assert.deepEqual(subs, [expectedSub(first), expectedSub(second)]);
    assert.notEqual(subs[0], subs[1]);

    const upDevice = makeDevice();
    const upId = newId();
    assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: upId, endpoint: service.url('/sub-up-keys'), keys: upDevice.keys })).status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${upId}`, emailPush('acc', ['e1']))).status, 200);
    assert.equal(JSON.parse(upDevice.decrypt(service.to('/sub-up-keys')[0].body)).sub, expectedSub(upId));
  });

  it('stays in a payload that had to be trimmed to fit', async () => {
    const id = newId();
    assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url('/sub-large'), accountLabel: 'l'.repeat(120) })).status, 200);
    const many = Array.from({ length: 400 }, (_, i) => `e${String(i).padStart(30, '0')}`);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('acc', many))).status, 200);
    const accounts: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 300; i++) accounts[`account${i}`] = { Email: `state${i}`, Mailbox: `state${i}` };
    accounts.mail = { EmailDelivery: 'fresh' };
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, stateChange(accounts))).status, 200);
    const bodies = service.to('/sub-large').map((request) => request.body);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.ok(body.length <= 3000, `the payload is ${body.length} bytes`);
      assert.equal(JSON.parse(body.toString()).sub, expectedSub(id));
    }
    assert.ok(JSON.parse(bodies[0].toString()).emailIds.length < many.length, 'the ids were not trimmed, so this proves nothing');
    assert.ok(Object.keys(JSON.parse(bodies[1].toString()).changed).length < 301, 'the accounts were not trimmed');
  });
});
