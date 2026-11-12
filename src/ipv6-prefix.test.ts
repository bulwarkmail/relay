// Behind TRUST_PROXY an IPv6 client counts by its /56: a provider hands a
// customer a /56 or a /48, and whoever holds many /64s inside one /56 is one
// client for the registration budget, the records per address and the host hold.
// IPv4 counts by address, and without TRUST_PROXY nothing changes.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { emailPush, makeDevice, newId, postJson, startFakePushService, startRelay, type FakePushService, type RunningRelay } from './test-support/harness.js';

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

async function register(relay: RunningRelay, pathname: string, forwardedFor?: string, id = newId()) {
  const res = await fetch(`${relay.base}/api/push/register/web`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
    body: JSON.stringify({ subscriptionId: id, subscription: { endpoint: service.url(pathname), keys: makeDevice().keys } }),
  });
  await res.arrayBuffer();
  return { id, status: res.status };
}

async function statuses(relay: RunningRelay, addresses: string[]) {
  const out: number[] = [];
  for (const address of addresses) out.push((await register(relay, '/v6', address)).status);
  return out;
}

describe('an IPv6 client behind TRUST_PROXY', () => {
  it('has one registration budget for its whole /56', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '600000' } });
    try {
      // Three /64s of 2001:db8:1::/56, one written with brackets and a port.
      assert.deepEqual(await statuses(relay, ['2001:db8:1:2::5', '2001:db8:1:3:aaaa::6', '[2001:db8:1:ff::7]:4711']), [200, 200, 429]);
      // The next /56 is somebody else.
      assert.deepEqual(await statuses(relay, ['2001:db8:1:100::5']), [200]);
      // IPv4 still counts by address.
      assert.deepEqual(await statuses(relay, ['203.0.113.1', '203.0.113.1', '203.0.113.1', '203.0.113.2']), [200, 200, 429, 200]);
    } finally {
      await relay.stop();
    }
  });

  it('holds its share of records for its whole /56', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS: '2' } });
    try {
      assert.deepEqual(await statuses(relay, ['2001:db8:2:10::1', '2001:db8:2:11::1', '2001:db8:2:12::1']), [200, 200, 507]);
      assert.deepEqual(await statuses(relay, ['2001:db8:2:110::1']), [200]);
    } finally {
      await relay.stop();
    }
  });

  // Each of `devices` delivers one push, then its service answers 429 to the next.
  async function throttle(relay: RunningRelay, devices: string[], forwardedFor: (i: number) => string) {
    const ids: string[] = [];
    for (const [i, pathname] of devices.entries()) {
      const { id, status } = await register(relay, pathname, forwardedFor(i));
      assert.equal(status, 200);
      ids.push(id);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e0']))).status, 200);
    }
    for (const pathname of devices) service.answer(pathname, { status: 429 });
    for (const id of ids) await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
  }

  it('counts as one address toward holding a push host for everyone', async () => {
    for (const [name, forwardedFor, status] of [
      ['five /64s of one /56', (i: number) => `2001:db8:3:${(i % 5) + 1}::1`, 200],
      ['five /56s', (i: number) => `2001:db8:3:${(((i % 5) + 1) * 0x100).toString(16)}::1`, 503],
    ] as const) {
      const relay = await startRelay({ env: { TRUST_PROXY: '1' } });
      try {
        const other = (await register(relay, `/hold-other-${status}`)).id;
        await throttle(relay, Array.from({ length: 20 }, (_, i) => `/hold-${status}-${i}`), forwardedFor);
        const push = await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e2']));
        assert.equal(push.status, status, `${name}: ${JSON.stringify(push.body)}`);
      } finally {
        await relay.stop();
      }
    }
  });
});

describe('a relay without TRUST_PROXY', () => {
  it('pays no attention to the addresses a client writes into X-Forwarded-For', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '600000', PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS: '2' } });
    try {
      // The socket is loopback, so there is no limit per address at all.
      assert.deepEqual(await statuses(relay, ['2001:db8:4:1::1', '2001:db8:4:2::1', '2001:db8:4:3::1', '2001:db8:4:4::1']), [200, 200, 200, 200]);
    } finally {
      await relay.stop();
    }
  });
});
