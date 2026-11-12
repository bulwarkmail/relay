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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CERT_FILE,
  apnsKeyPem,
  blockStoreWrites,
  emailPush,
  getJson,
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
  testVapid,
  type FakePushService,
} from './test-support/harness.js';

const DEFAULT_MAX_SUBSCRIPTIONS = 50_000;
const DAY = 24 * 60 * 60 * 1000;
const METRICS_TOKEN = 'scrape-secret-0123456789';

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

async function register(relay: { base: string }, id: string, pathname: string, forwardedFor?: string) {
  const res = await fetch(`${relay.base}/api/push/register/unifiedpush`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(forwardedFor !== undefined ? { 'x-forwarded-for': forwardedFor } : {}) },
    body: JSON.stringify({ subscriptionId: id, endpoint: service.url(pathname) }),
  });
  await res.arrayBuffer();
  return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

const known = async (relay: { base: string }, id: string) => (await getJson(relay.base, `/api/push/active/${id}`)).status === 200;

/** Every file under the data directory with its size, change time and inode. */
function dirStamp(dir: string): string {
  const lines: string[] = [];
  const walk = (folder: string) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full, { bigint: true });
        lines.push(`${path.relative(dir, full)} ${stat.size} ${stat.mtimeNs} ${stat.ino}`);
      }
    }
  };
  walk(dir);
  return lines.sort().join('\n');
}

async function settled(dir: string): Promise<string> {
  // A store may write a moment after it answers. Wait until two looks agree.
  let last = dirStamp(dir);
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const now = dirStamp(dir);
    if (now === last && i >= 2) return now;
    last = now;
  }
  return last;
}

/** A store with this many records, in the file format of the relay before this one. */
function seedLegacyStore(count: number): string {
  const records: Record<string, unknown> = {};
  const keys = makeDevice().keys;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    records[`seed${String(i).padStart(12, '0')}`] = { kind: 'up', endpoint: `https://d.example/x${i}`, keys, verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now };
  }
  return seedStore(records);
}

describe('how many records the store takes', () => {
  it('refuses a new id at the limit with 507, and keeps serving the records it has', async () => {
    const relay = await startRelay({ env: { PUSH_MAX_SUBSCRIPTIONS: '5', PUSH_REGISTER_BURST: '1000' } });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await register(relay, id, '/limits')).status, 200);
      }
      const refused = newId();
      assert.equal((await register(relay, refused, '/limits')).status, 507, 'a sixth record at a limit of five');
      assert.equal(await known(relay, refused), false, 'the refused record is not in the store');
      for (const id of ids) assert.equal(await known(relay, id), true);
      // A device that is already there checks in on every page load: that still works.
      assert.equal((await register(relay, ids[0], '/limits-again')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${ids[1]}`, emailPush('a', ['e1']))).status, 200);
      // A place that comes free can be taken.
      assert.equal((await getJson(relay.base, `/api/push/register/${ids[2]}`, 'DELETE')).status, 200);
      assert.equal((await register(relay, refused, '/limits')).status, 200);
      // And the limit survives a restart.
      const again = await relay.restart();
      try {
        assert.equal((await register(again, newId(), '/limits')).status, 507);
        assert.equal(await known(again, ids[0]), true);
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop();
    }
  });

  it('has the default limit when none is configured, and starts on a store written by the relay before it', async () => {
    const full = seedLegacyStore(DEFAULT_MAX_SUBSCRIPTIONS);
    const almost = seedLegacyStore(DEFAULT_MAX_SUBSCRIPTIONS - 1);
    const relayFull = await startRelay({ dataDir: full, env: { PUSH_REGISTER_BURST: '1000' } });
    const relayAlmost = await startRelay({ dataDir: almost, env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      assert.equal(await known(relayFull, 'seed000000000000'), true, 'the records of the old store are there');
      assert.equal((await register(relayFull, newId(), '/limits')).status, 507, `a relay holding ${DEFAULT_MAX_SUBSCRIPTIONS} records took one more`);
      assert.equal((await register(relayFull, 'seed000000000001', '/limits')).status, 200, 'a record that exists registers again');
      assert.equal((await register(relayAlmost, newId(), '/limits')).status, 200, 'one place was left');
      assert.equal((await register(relayAlmost, newId(), '/limits')).status, 507);
    } finally {
      await relayFull.stop('SIGKILL');
      await relayAlmost.stop('SIGKILL');
      fs.rmSync(full, { recursive: true, force: true });
      fs.rmSync(almost, { recursive: true, force: true });
    }
  });

  it('counts an id registered over and over as one record', async () => {
    const relay = await startRelay({ env: { PUSH_MAX_SUBSCRIPTIONS: '3', PUSH_REGISTER_BURST: '1000' } });
    try {
      const again = newId();
      for (let i = 0; i < 10; i++) assert.equal((await register(relay, again, `/same-${i}`)).status, 200);
      assert.equal((await register(relay, newId(), '/limits')).status, 200);
      assert.equal((await register(relay, newId(), '/limits')).status, 200);
      assert.equal((await register(relay, newId(), '/limits')).status, 507);
      // At the limit the id that is there still moves to its new endpoint.
      assert.equal((await register(relay, again, '/same-last')).status, 200);
      assert.equal(storedRecords(relay.dataDir)[again].endpoint, service.url('/same-last'));
    } finally {
      await relay.stop();
    }
  });

  it('lets a record that never worked go after 7 days, and frees its place', async () => {
    const now = Date.now();
    const base = { kind: 'up', keys: null, verificationCode: null };
    const ids = { unused: newId(), unusedRecent: newId(), pushed: newId(), collected: newId() };
    const dataDir = seedStore({
      [ids.unused]: { ...base, endpoint: service.url('/unused'), createdAt: now - 10 * DAY, lastRegisteredAt: now - 8 * DAY, lastPushAt: null },
      [ids.unusedRecent]: { ...base, endpoint: service.url('/unused-recent'), createdAt: now - 10 * DAY, lastRegisteredAt: now - 6 * DAY, lastPushAt: null },
      [ids.pushed]: { ...base, endpoint: service.url('/pushed'), createdAt: now - 60 * DAY, lastPushAt: now - 30 * DAY },
      [ids.collected]: { ...base, endpoint: service.url('/collected'), verificationCode: 'c', createdAt: now - 60 * DAY, lastRegisteredAt: now - 30 * DAY, codeCollectedAt: now - 60 * DAY, lastPushAt: null },
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '4', PUSH_REGISTER_BURST: '1000' } });
    try {
      assert.equal(await known(relay, ids.unused), false, 'never delivered, no code collected, quiet for 8 days');
      for (const id of [ids.unusedRecent, ids.pushed, ids.collected]) assert.equal(await known(relay, id), true);
      assert.equal((await register(relay, newId(), '/limits')).status, 200, 'its place is free');
      // The store is full now. The next device takes the place of the record that
      // never delivered and whose code no client collected, before the one whose code was.
      assert.equal((await register(relay, newId(), '/limits')).status, 200);
      assert.equal(await known(relay, ids.unusedRecent), false);
      assert.equal(await known(relay, ids.collected), true);
    } finally {
      await relay.stop();
    }
  });
});

describe('who gives way when the store is full', () => {
  const base = { kind: 'up', keys: null, verificationCode: null };

  it('drops records that never delivered, registered longest ago first, and never one in its first minutes', async () => {
    const now = Date.now();
    const ids = { worked: newId(), older: newId(), old: newId() };
    const dataDir = seedStore({
      [ids.worked]: { ...base, endpoint: service.url('/give-worked'), createdAt: now - 60 * DAY, lastPushAt: now - DAY },
      [ids.old]: { ...base, endpoint: service.url('/give-old'), createdAt: now - 2 * DAY, lastRegisteredAt: now - 60 * 60 * 1000, lastPushAt: null },
      [ids.older]: { ...base, endpoint: service.url('/give-older'), createdAt: now - 2 * DAY, lastRegisteredAt: now - 2 * 60 * 60 * 1000, lastPushAt: null },
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '3', METRICS_TOKEN } });
    try {
      const first = newId();
      assert.equal((await register(relay, first, '/give-new')).status, 200, 'a new device was refused while records that never worked were there');
      assert.equal(await known(relay, ids.older), false);
      assert.equal(await known(relay, ids.old), true);
      assert.equal((await register(relay, newId(), '/give-new')).status, 200);
      assert.equal(await known(relay, ids.old), false);
      // Left: a record that delivered yesterday and two devices registered just now.
      const refused = await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: newId(), endpoint: service.url('/give-new') });
      assert.equal(refused.status, 507);
      assert.deepEqual(refused.body, { error: 'Relay is full' });
      assert.equal(await known(relay, ids.worked), true);
      assert.equal(await known(relay, first), true);
      const metrics = await (await fetch(`${relay.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      assert.match(metrics, /^relay_subscriptions_unregistered_total\{reason="evicted",transport="up"\} 2$/m);
    } finally {
      await relay.stop();
    }
  });

  it('then drops the record whose last push is the oldest, but none that delivered in the last 30 days', async () => {
    const now = Date.now();
    const ids = { recent: newId(), longAgo: newId(), lessLongAgo: newId() };
    const dataDir = seedStore({
      [ids.recent]: { ...base, endpoint: service.url('/give-recent'), createdAt: now - 90 * DAY, lastPushAt: now - 29 * DAY },
      [ids.longAgo]: { ...base, endpoint: service.url('/give-long-ago'), createdAt: now - 90 * DAY, lastPushAt: now - 40 * DAY },
      [ids.lessLongAgo]: { ...base, endpoint: service.url('/give-less-long-ago'), createdAt: now - 90 * DAY, lastPushAt: now - 35 * DAY, lastRegisteredAt: now - DAY },
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '3' } });
    try {
      assert.equal((await register(relay, newId(), '/give-new')).status, 200);
      assert.equal(await known(relay, ids.longAgo), false);
      // A registration since doesn't move a record forward: only a push does.
      assert.equal((await register(relay, newId(), '/give-new')).status, 200);
      assert.equal(await known(relay, ids.lessLongAgo), false);
      assert.equal((await register(relay, newId(), '/give-new')).status, 507);
      assert.equal(await known(relay, ids.recent), true);
    } finally {
      await relay.stop();
    }
  });

  it('drops records whose code no client collected before those whose code was, each registered longest ago first', async () => {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;
    const ids = { collectedOlder: newId(), collected: newId(), uncollectedOlder: newId(), uncollected: newId(), quiet: newId() };
    const dataDir = seedStore({
      [ids.collectedOlder]: { ...base, endpoint: service.url('/order-collected-older'), verificationCode: 'c', createdAt: now - 5 * HOUR, lastRegisteredAt: now - 5 * HOUR, codeCollectedAt: now - 5 * HOUR, lastPushAt: null },
      [ids.collected]: { ...base, endpoint: service.url('/order-collected'), verificationCode: 'c', createdAt: now - 4 * HOUR, lastRegisteredAt: now - 4 * HOUR, codeCollectedAt: now - 4 * HOUR, lastPushAt: null },
      [ids.uncollectedOlder]: { ...base, endpoint: service.url('/order-uncollected-older'), createdAt: now - 3 * HOUR, lastRegisteredAt: now - 3 * HOUR, lastPushAt: null },
      [ids.uncollected]: { ...base, endpoint: service.url('/order-uncollected'), createdAt: now - 2 * HOUR, lastRegisteredAt: now - 2 * HOUR, lastPushAt: null },
      [ids.quiet]: { ...base, endpoint: service.url('/order-quiet'), createdAt: now - 90 * DAY, lastPushAt: now - 40 * DAY },
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '5' } });
    try {
      const gone: string[] = [];
      for (let i = 0; i < 5; i++) {
        // A new device that finishes its setup: its code is collected.
        const id = newId();
        assert.equal((await register(relay, id, `/order-new-${i}`)).status, 200);
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification(`code-${i}`))).status, 200);
        assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: `code-${i}` });
        for (const [name, seeded] of Object.entries(ids)) if (!gone.includes(name) && !(await known(relay, seeded))) gone.push(name);
      }
      assert.deepEqual(gone, ['uncollectedOlder', 'uncollected', 'collectedOlder', 'collected', 'quiet']);
      // Left: five new devices in their first minutes.
      assert.equal((await register(relay, newId(), '/order-refused')).status, 507);
    } finally {
      await relay.stop();
    }
  });

  it('keeps a confirmed phone that has had no mail yet while records whose code nobody collected are there', async () => {
    const now = Date.now();
    const MINUTE = 60 * 1000;
    const phone = newId();
    const stranger = [newId(), newId(), newId()];
    const dataDir = seedStore({
      [phone]: { ...base, endpoint: service.url('/stranger-phone'), verificationCode: 'c', createdAt: now - 60 * MINUTE, lastRegisteredAt: now - 60 * MINUTE, codeCollectedAt: now - 59 * MINUTE, lastPushAt: null },
      ...Object.fromEntries(stranger.map((id, i) => [id, { ...base, endpoint: service.url(`/stranger-${i}`), createdAt: now - (32 - i) * MINUTE, lastRegisteredAt: now - (32 - i) * MINUTE, lastPushAt: null }])),
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '4' } });
    try {
      // Records without a collected code go first, oldest first, though the phone was registered before them.
      for (const id of stranger) {
        assert.equal((await register(relay, newId(), '/stranger-new')).status, 200);
        assert.equal(await known(relay, id), false);
        assert.equal(await known(relay, phone), true, 'the confirmed phone gave way while records without a code were there');
      }
      // The records without a code are now new ones in their first minutes; the phone
      // doesn't give way while they are there either.
      assert.equal((await register(relay, newId(), '/stranger-new')).status, 507);
      assert.equal(await known(relay, phone), true);
    } finally {
      await relay.stop();
    }
  });

  it('moves a record that delivers to the back of the line', async () => {
    const now = Date.now();
    const ids = { quiet: newId(), pushedNow: newId() };
    const dataDir = seedStore({
      [ids.pushedNow]: { ...base, endpoint: service.url('/give-pushed-now'), createdAt: now - 90 * DAY, lastPushAt: now - 50 * DAY },
      [ids.quiet]: { ...base, endpoint: service.url('/give-quiet'), createdAt: now - 90 * DAY, lastPushAt: now - 45 * DAY },
    });
    const relay = await startRelay({ dataDir, env: { PUSH_MAX_SUBSCRIPTIONS: '2' } });
    try {
      assert.equal((await postJson(relay.base, `/api/push/jmap/${ids.pushedNow}`, emailPush('a', ['e1']))).status, 200);
      assert.equal((await register(relay, newId(), '/give-new')).status, 200);
      assert.equal(await known(relay, ids.quiet), false);
      assert.equal(await known(relay, ids.pushedNow), true);
    } finally {
      await relay.stop();
    }
  });
});

describe('how many records one address may hold', () => {
  it('refuses a new device from an address that holds its share, and nobody else', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS: '3' } });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await register(relay, id, '/address', '198.51.100.70')).status, 200);
      }
      const refused = await fetch(`${relay.base}/api/push/register/unifiedpush`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.70' },
        body: JSON.stringify({ subscriptionId: newId(), endpoint: service.url('/address') }),
      });
      assert.equal(refused.status, 507);
      assert.deepEqual(await refused.json(), { error: 'Too many devices registered from this address' });
      // Its own devices register again, and other addresses are not touched.
      assert.equal((await register(relay, ids[0], '/address-again', '198.51.100.70')).status, 200);
      assert.equal((await register(relay, newId(), '/address', '198.51.100.71')).status, 200);
      // A device that registers from elsewhere now counts there, and frees a place.
      assert.equal((await register(relay, ids[1], '/address-moved', '198.51.100.72')).status, 200);
      assert.equal((await register(relay, newId(), '/address', '198.51.100.70')).status, 200);
      // A delete frees one too.
      assert.equal((await getJson(relay.base, `/api/push/register/${ids[2]}`, 'DELETE')).status, 200);
      assert.equal((await register(relay, newId(), '/address', '198.51.100.70')).status, 200);
      assert.equal((await register(relay, newId(), '/address', '198.51.100.70')).status, 507);
    } finally {
      await relay.stop();
    }
  });

  it('has no share per address where the relay sits behind a proxy it was not told about', async () => {
    const relay = await startRelay({ env: { PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS: '3' } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await register(relay, newId(), '/address-proxy')).status);
      assert.deepEqual(statuses, Array(6).fill(200));
    } finally {
      await relay.stop();
    }
  });
});

describe('how fast one address may register', () => {
  it('holds a burst from one client address back with 429 and Retry-After, and leaves other addresses alone', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '5', PUSH_REGISTER_REFILL_MS: '60000' } });
    try {
      const statuses: number[] = [];
      const ids: string[] = [];
      let retryAfter: string | null = null;
      for (let i = 0; i < 8; i++) {
        const id = newId();
        ids.push(id);
        const res = await register(relay, id, '/limits', '203.0.113.7');
        statuses.push(res.status);
        if (res.status === 429) retryAfter = res.retryAfter;
      }
      assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429]);
      assert.ok(Number(retryAfter) >= 1, `Retry-After was ${retryAfter}`);
      assert.equal(await known(relay, ids[4]), true);
      assert.equal(await known(relay, ids[5]), false, 'a registration answered 429 left a record');
      // The proxy appends the address it saw. What the client wrote in front of it does not count.
      for (const forged of ['198.51.100.1, 203.0.113.7', '10.0.0.1,203.0.113.7', 'unknown, 198.51.100.9 , 203.0.113.7']) {
        assert.equal((await register(relay, newId(), '/limits', forged)).status, 429, `X-Forwarded-For "${forged}" got a budget of its own`);
      }
      // Somebody else, through the same proxy, at the same moment.
      assert.equal((await register(relay, newId(), '/limits', '203.0.113.8')).status, 200);
      assert.equal((await register(relay, newId(), '/limits', '198.51.100.1, 203.0.113.9')).status, 200);
      // A device that is held back is not told its record is gone: an id that exists still answers.
      assert.equal(await known(relay, ids[0]), true);
    } finally {
      await relay.stop();
    }
  });

  it('does not lump every client together when it sits behind a proxy it was not told about', async () => {
    // No TRUST_PROXY, and the peer is 127.0.0.1: that is a proxy, or a local caller. All of the
    // relay's users would share one budget, so there is no per-address limit here. The record
    // limit still holds.
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '5', PUSH_REGISTER_REFILL_MS: '60000', PUSH_MAX_SUBSCRIPTIONS: '12' } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await register(relay, newId(), '/limits', i % 2 ? `203.0.113.${i}` : undefined)).status);
      assert.deepEqual(statuses, Array(12).fill(200), 'real devices behind the proxy were refused');
      assert.equal((await register(relay, newId(), '/limits')).status, 507);
      // The operator hears about it once.
      assert.equal(relay.logs().split('set TRUST_PROXY').length - 1, 1, relay.logs());
    } finally {
      await relay.stop();
    }
  });

  it('falls back to the socket when the proxy sent no X-Forwarded-For', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '60000' } });
    try {
      // The socket is 127.0.0.1, a proxy's address: no budget for all of its clients together.
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await register(relay, newId(), '/limits')).status);
      assert.deepEqual(statuses, Array(6).fill(200));
    } finally {
      await relay.stop();
    }
  });

  it('spends the budget on an id registered over and over, and leaves the record of a refused one as it was', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '60000' } });
    try {
      const id = newId();
      assert.equal((await register(relay, id, '/kept', '198.51.100.20')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('kept-code'))).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
      const before = storedRecords(relay.dataDir)[id];
      assert.ok(before.lastPushAt);
      assert.equal((await register(relay, id, '/kept', '198.51.100.20')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('kept-code'))).status, 200);
      const settledBefore = storedRecords(relay.dataDir)[id];
      const refused = await register(relay, id, '/moved', '198.51.100.20');
      assert.equal(refused.status, 429, 'the third registration of one id was free');
      assert.deepEqual(storedRecords(relay.dataDir)[id], settledBefore, 'a refused registration changed the record');
      assert.equal(settledBefore.endpoint, service.url('/kept'));
      assert.equal(settledBefore.lastPushAt, before.lastPushAt);
      assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: 'kept-code' });
    } finally {
      await relay.stop();
    }
  });

  it('gives no address an unlimited budget, whatever the header looks like', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '60000' } });
    try {
      const run = async (headers: string[]) => {
        const statuses: number[] = [];
        for (const header of headers) statuses.push((await register(relay, newId(), '/limits', header)).status);
        return statuses;
      };
      // One IPv6 client holds a /56: every address in it, and the same with brackets and a port, is one budget.
      assert.deepEqual(await run(['2001:db8:1:2::5', '2001:db8:1:2:aaaa::6', '[2001:db8:1:2::7]:4711']), [200, 200, 429]);
      assert.deepEqual(await run(['2001:db8:1:3::5']), [429], 'the next /64 of the same /56 is the same client');
      assert.deepEqual(await run(['2001:db8:1:100::5']), [200], 'the next /56 is somebody else');
      // A port behind the address is the same address.
      assert.deepEqual(await run(['203.0.113.50', '203.0.113.50:4711', '203.0.113.50:4712']), [200, 200, 429]);
      // An IPv4 address written as IPv6 is that address.
      assert.deepEqual(await run(['::ffff:203.0.113.60', '203.0.113.60', '::ffff:203.0.113.60']), [200, 200, 429]);
      // An entry that is no address at all: all of them share one budget.
      assert.deepEqual(await run(['', 'garbage', 'unknown', ' , ']), [200, 200, 429, 429]);
    } finally {
      await relay.stop();
    }
  });

  it('does not lump every client together when the address the proxy saw is another proxy', async () => {
    // TRUST_PROXY=1, and the nearest proxy appends the address of a proxy in front of it:
    // a private or loopback one. Every client then has that address. The relay can't tell
    // them apart, as with a private socket address, so there is no budget for all of them
    // together, and the operator hears about it once.
    for (const outer of ['10.0.0.5', '127.0.0.1', '192.168.1.1', '172.18.0.1', '::1', 'fd00::5']) {
      const relay = await startRelay({ env: { TRUST_PROXY: '1', PUSH_REGISTER_BURST: '2', PUSH_REGISTER_REFILL_MS: '60000', PUSH_MAX_SUBSCRIPTIONS_PER_ADDRESS: '2' } });
      try {
        const statuses: number[] = [];
        for (let i = 1; i <= 5; i++) statuses.push((await register(relay, newId(), '/two-proxies', `203.0.113.${i}, ${outer}`)).status);
        assert.deepEqual(statuses, Array(5).fill(200), `five different clients behind ${outer} were held to one budget`);
        assert.equal(relay.logs().split('set TRUST_PROXY').length - 1, 1, 'the operator was not told');
      } finally {
        await relay.stop();
      }
    }
  });
});

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

  it('takes an FCM token as long as Firebase hands out, with room, and none longer than 2,048', async () => {
    service.answer('/oauth/size-token', { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }) });
    const relay = await startRelay({
      env: {
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount('size-project', service.url('/oauth/size-token'))),
      },
    });
    try {
      const fcm = (fcmToken: string) => postJson(relay.base, '/api/push/register', { subscriptionId: newId(), fcmToken, accountLabel: 'alice@example.org' });
      // The shape Firebase hands out: an instance id, a colon, about 140 more.
      assert.equal((await fcm(`${'c'.repeat(22)}:APA91b${'d'.repeat(134)}`)).status, 200);
      assert.equal((await fcm('e'.repeat(1024))).status, 200);
      assert.equal((await fcm('e'.repeat(1025))).status, 200);
      // With the longest label, so the whole registration is as large as an FCM one gets.
      assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: newId(), fcmToken: 'e'.repeat(2048), accountLabel: '€'.repeat(120) })).status, 200);
      assert.equal((await fcm('e'.repeat(2049))).status, 400);
      assert.equal((await fcm('e'.repeat(4096))).status, 400);
    } finally {
      await relay.stop();
    }
  });
});

describe('what a request that changes nothing costs', () => {
  it('does not write for a verification code it already has, and keeps a new one across a restart', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      await register(relay, id, '/limits');
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('same-code'))).status, 200);
      const before = await settled(relay.dataDir);
      for (let i = 0; i < 5; i++) {
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('same-code'))).status, 200);
      }
      assert.equal(await settled(relay.dataDir), before, 'the same code again changed files in the data directory');
      // The control: a code that is new is written, and is there after a restart.
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('next-code'))).status, 200);
      const again = await relay.restart();
      try {
        assert.deepEqual((await getJson(again.base, `/api/push/verify/${id}`)).body, { verificationCode: 'next-code' });
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop();
    }
  });

  it('writes a verification code each time it changes and only then, and keeps the last one', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      await register(relay, id, '/codes');
      let stamp = await settled(relay.dataDir);
      const wrote: boolean[] = [];
      for (const code of ['code-a', 'code-a', 'code-b', 'code-b', 'code-a']) {
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification(code))).status, 200);
        const now = await settled(relay.dataDir);
        wrote.push(now !== stamp);
        stamp = now;
      }
      assert.deepEqual(wrote, [true, false, true, false, true]);
      const again = await relay.restart();
      try {
        assert.deepEqual((await getJson(again.base, `/api/push/verify/${id}`)).body, { verificationCode: 'code-a' });
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop();
    }
  });

  it('notes a delivered push once a minute, not on every push', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      await register(relay, id, '/pushes');
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 200);
      const before = await settled(relay.dataDir);
      for (let i = 2; i <= 4; i++) {
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`e${i}`]))).status, 200);
      }
      assert.equal(await settled(relay.dataDir), before, 'pushes right after one another changed files in the data directory');
      assert.equal(service.to('/pushes').length, 4);
      assert.deepEqual((await getJson(relay.base, `/api/push/active/${id}`)).body, { active: true });
    } finally {
      await relay.stop();
    }
  });
});

describe('a store that keeps what it answered', () => {
  it('has every registration it answered after being killed in the middle of a burst', async () => {
    const relay = await startRelay();
    const answered: string[] = [];
    let killed: Promise<unknown> | null = null;
    await Promise.allSettled(Array.from({ length: 40 }, () => newId()).map(async (id) => {
      const res = await register(relay, id, '/burst');
      if (res.status === 200) answered.push(id);
      if (answered.length === 20 && !killed) killed = relay.stop('SIGKILL');
    }));
    await killed;
    assert.ok(answered.length >= 20, `${answered.length} answered`);
    const again = await startRelay({ dataDir: relay.dataDir });
    try {
      const missing = [];
      for (const id of answered) if (!(await known(again, id))) missing.push(id);
      assert.deepEqual(missing, [], `${missing.length} of ${answered.length} answered registrations were gone after the restart`);
    } finally {
      await again.stop();
    }
  });

  it('answers 500 to a change it cannot write, keeps nothing of it, and counts it', async () => {
    const relay = await startRelay({ env: { METRICS_TOKEN } });
    try {
      const id = newId();
      await register(relay, id, '/kept');
      await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('first-code'));
      assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: 'first-code' });
      blockStoreWrites(relay.dataDir);
      const fresh = newId();
      assert.equal((await register(relay, fresh, '/lost')).status, 500);
      assert.equal(await known(relay, fresh), false, 'a registration that never reached the disk is served from memory');
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('second-code'))).status, 500);
      assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: 'first-code' });
      assert.equal((await getJson(relay.base, `/api/push/register/${id}`, 'DELETE')).status, 500);
      assert.equal(await known(relay, id), true);
      const metrics = await (await fetch(`${relay.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      assert.match(metrics, /^relay_store_write_failures_total 3$/m);
    } finally {
      await relay.stop();
    }
  });

  it('starts on a store the relay before it wrote, with every kind of record and its code', async () => {
    const now = Date.now();
    const ids = { fcm: newId(), apns: newId(), web: newId(), up: newId(), unmarked: newId() };
    const device = makeDevice();
    // As that relay wrote it: indented, every record whole.
    const dataDir = seedStore(JSON.stringify({
      records: {
        [ids.fcm]: { kind: 'fcm', fcmToken: 'f'.repeat(100), verificationCode: 'code-fcm', createdAt: now, lastPushAt: null, lastRegisteredAt: now, accountLabel: 'a@example.org' },
        [ids.apns]: { kind: 'apns', deviceToken: 'ab'.repeat(32), environment: 'production', verificationCode: 'code-apns', createdAt: now, lastPushAt: now, codeCollectedAt: now },
        [ids.web]: { kind: 'web', webPush: { endpoint: service.url('/legacy-web'), keys: device.keys }, verificationCode: 'code-web', createdAt: now, lastPushAt: null },
        [ids.up]: { kind: 'up', endpoint: service.url('/legacy-up'), keys: null, verificationCode: 'code-up', createdAt: now, lastPushAt: null },
        // From before the transports had names: only an FCM token.
        [ids.unmarked]: { fcmToken: 'g'.repeat(100), verificationCode: 'code-unmarked', createdAt: now, lastPushAt: null },
      },
    }, null, 2));
    const relay = await startRelay({ dataDir, env: { METRICS_TOKEN } });
    try {
      for (const [kind, id] of Object.entries(ids)) {
        assert.deepEqual((await getJson(relay.base, `/api/push/verify/${id}`)).body, { verificationCode: `code-${kind}` }, kind);
      }
      const metrics = await (await fetch(`${relay.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      for (const [transport, count] of [['fcm', 2], ['apns', 1], ['web', 1], ['up', 1]] as const) {
        assert.match(metrics, new RegExp(`^relay_subscriptions_active\\{transport="${transport}"\\} ${count}$`, 'm'));
      }
      assert.equal((await postJson(relay.base, `/api/push/jmap/${ids.web}`, emailPush('a', ['e1']))).status, 200);
      assert.deepEqual(JSON.parse(device.decrypt(service.to('/legacy-web')[0].body)).emailIds, ['e1']);
    } finally {
      await relay.stop();
    }
  });
});

describe('one endpoint written many ways', () => {
  const web = (relay: { base: string }, id: string, pathname: string) =>
    postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url(pathname), keys: makeDevice().keys } });

  it('counts as one device when its push service says 429, so it cannot put the service on hold for everyone', async () => {
    const relay = await startRelay({ env: { PUSH_REGISTER_BURST: '1000' } });
    try {
      const victim = newId();
      const device = makeDevice();
      assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: victim, subscription: { endpoint: service.url('/honest-device'), keys: device.keys } })).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e1']))).status, 200);
      service.answer('/throttled', { status: 429 });
      for (let i = 0; i < 20; i++) {
        const id = newId();
        assert.equal((await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url(`/throttled#${i}`), keys: makeDevice().keys } })).status, 200);
        await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`x${i}`]));
      }
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
      assert.equal(service.to('/honest-device').length, 2);
    } finally {
      await relay.stop();
    }
  });

  it('does not count twenty endpoints that never delivered toward holding their host', async () => {
    const relay = await startRelay();
    try {
      const victim = newId();
      assert.equal((await web(relay, victim, '/honest-query')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e1']))).status, 200);
      for (let i = 0; i < 20; i++) {
        // Twenty different URLs: the query is part of what the service sees.
        service.answer(`/throttled-query?n=${i}`, { status: 429 });
        const id = newId();
        assert.equal((await web(relay, id, `/throttled-query?n=${i}`)).status, 200);
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`x${i}`]))).status, 503);
      }
      assert.equal(service.requests.filter((r) => r.path.startsWith('/throttled-query')).length, 20);
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
    } finally {
      await relay.stop();
    }
  });

  it('takes an endpoint that delivered before, written with twenty fragments, for one device', async () => {
    const relay = await startRelay();
    try {
      const victim = newId();
      assert.equal((await web(relay, victim, '/honest-fragment')).status, 200);
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await web(relay, id, `/fragments#${i}`)).status, 200);
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e0']))).status, 200);
      }
      service.answer('/fragments', { status: 429 });
      for (const id of ids) assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 503);
      // The service said 429 once; the other nineteen waited for the same endpoint.
      assert.equal(service.to('/fragments').length, 21);
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
    } finally {
      await relay.stop();
    }
  });

  it('keeps a backoff the endpoint earned when its id registers again', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      service.answer('/backoff-kept', { status: 429, headers: { 'retry-after': '120' } });
      assert.equal((await web(relay, id, '/backoff-kept')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']))).status, 503);
      service.answer('/backoff-kept', { status: 201 });
      for (const pathname of ['/backoff-kept', '/backoff-kept#again']) {
        assert.equal((await web(relay, id, pathname)).status, 200);
        const held = await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e2']));
        assert.equal(held.status, 503, pathname);
        assert.deepEqual(held.body, { ok: false, held: 'push-service-backoff' });
      }
      assert.equal(service.to('/backoff-kept').length, 1, 'a registration of the same endpoint ended the backoff');
      // Another id on the same endpoint waits too: the service throttled the endpoint.
      const other = newId();
      assert.equal((await web(relay, other, '/backoff-kept')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e3']))).status, 503);
      // A new endpoint starts afresh.
      assert.equal((await web(relay, id, '/backoff-fresh')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e4']))).status, 200);
    } finally {
      await relay.stop();
    }
  });

  it('holds back a burst to one native app as it does to a browser', async () => {
    const apns = await startFakeApns();
    const json = { 'content-type': 'application/json' };
    service.answer('/oauth/burst-token', { status: 200, headers: json, body: JSON.stringify({ access_token: 'fake-access-token', expires_in: 3600 }) });
    const send = '/v1/projects/burst-project/messages:send';
    service.answer(send, { status: 200, headers: json, body: '{"name":"x"}' });
    const relay = await startRelay({
      env: {
        PUSH_SUBSCRIPTION_BURST: '3',
        PUSH_SUBSCRIPTION_REFILL_MS: '60000',
        APNS_KEY: apnsKeyPem(),
        APNS_KEY_ID: 'KEYID12345',
        APNS_TEAM_ID: 'TEAM123456',
        APNS_ORIGIN: apns.origin,
        FCM_ORIGIN: service.url('').replace(/\/$/, ''),
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(serviceAccount('burst-project', service.url('/oauth/burst-token'))),
      },
    });
    try {
      const apnsId = newId();
      const fcmId = newId();
      assert.equal((await postJson(relay.base, '/api/push/register/apns', { subscriptionId: apnsId, deviceToken: 'ef'.repeat(32), environment: 'production' })).status, 200);
      assert.equal((await postJson(relay.base, '/api/push/register', { subscriptionId: fcmId, fcmToken: 'b'.repeat(100) })).status, 200);
      for (const id of [apnsId, fcmId]) {
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) statuses.push((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`e${i}`]))).status);
        assert.deepEqual(statuses, [200, 200, 200, 429, 429], id === apnsId ? 'APNs' : 'FCM');
      }
      assert.equal(apns.requests.length, 3);
      assert.equal(service.to(send).length, 3);
    } finally {
      await relay.stop();
      await apns.close();
    }
  });

  // Each of `devices` delivers one push, then its service answers 429 to the next.
  // `forwardedFor` gives the client address each was registered from.
  async function throttle(relay: { base: string }, devices: string[], forwardedFor: (i: number) => string | undefined) {
    const ids: string[] = [];
    for (const [i, pathname] of devices.entries()) {
      const id = newId();
      ids.push(id);
      const res = await fetch(`${relay.base}/api/push/register/web`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(forwardedFor(i) ? { 'x-forwarded-for': forwardedFor(i)! } : {}) },
        body: JSON.stringify({ subscriptionId: id, subscription: { endpoint: service.url(pathname), keys: makeDevice().keys } }),
      });
      await res.arrayBuffer();
      assert.equal(res.status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e0']))).status, 200);
    }
    for (const pathname of devices) service.answer(pathname, { status: 429 });
    for (const id of ids) await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
  }

  it('cannot put its push service on hold for everyone once each spelling has delivered a push', async () => {
    const relay = await startRelay();
    try {
      const victim = newId();
      assert.equal((await web(relay, victim, '/honest-device-q')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e1']))).status, 200);
      // One endpoint, twenty queries. A push service answers 2xx until an endpoint is over its
      // quota, so each of them has delivered a push before the 429s come.
      await throttle(relay, Array.from({ length: 20 }, (_, i) => `/one-endpoint?n=${i}`), () => undefined);
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
      assert.equal(service.to('/honest-device-q').length, 2);
    } finally {
      await relay.stop();
    }
  });

  it('does not hold a host for everyone over devices registered from one client address', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1' } });
    try {
      const victim = newId();
      assert.equal((await web(relay, victim, '/one-address-victim')).status, 200);
      await throttle(relay, Array.from({ length: 20 }, (_, i) => `/one-address-${i}`), () => '198.51.100.30');
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
    } finally {
      await relay.stop();
    }
  });

  it('does not hold a host for everyone over devices whose client addresses it cannot tell apart', async () => {
    // No TRUST_PROXY and a loopback peer, as behind a proxy the relay wasn't told about: every
    // registration may be one caller's, so they count as one address together.
    const relay = await startRelay();
    try {
      const other = newId();
      assert.equal((await web(relay, other, '/unknown-addresses-other')).status, 200);
      await throttle(relay, Array.from({ length: 20 }, (_, i) => `/unknown-addresses-${i}`), () => undefined);
      const push = await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
      // Each endpoint the service throttled still waits on its own.
      service.answer('/unknown-addresses-0', { status: 201 });
      const own = newId();
      assert.equal((await web(relay, own, '/unknown-addresses-0')).status, 200);
      assert.deepEqual((await postJson(relay.base, `/api/push/jmap/${own}`, emailPush('a', ['e3']))).body, { ok: false, held: 'push-service-backoff' });
    } finally {
      await relay.stop();
    }
  });

  it('does not hold a host for everyone over devices whose client address it lost in a restart', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1' } });
    let again: Awaited<ReturnType<typeof startRelay>> | null = null;
    try {
      const devices = Array.from({ length: 20 }, (_, i) => `/restarted-${i}`);
      const ids: string[] = [];
      for (const pathname of devices) {
        const id = newId();
        ids.push(id);
        const res = await fetch(`${relay.base}/api/push/register/web`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.31' },
          body: JSON.stringify({ subscriptionId: id, subscription: { endpoint: service.url(pathname), keys: makeDevice().keys } }),
        });
        await res.arrayBuffer();
        assert.equal(res.status, 200);
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e0']))).status, 200);
      }
      // Addresses are kept in memory only: after the restart none of the twenty has one.
      again = await relay.restart();
      const other = newId();
      assert.equal((await web(again, other, '/restarted-other')).status, 200);
      for (const pathname of devices) service.answer(pathname, { status: 429 });
      for (const id of ids) await postJson(again.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      const push = await postJson(again.base, `/api/push/jmap/${other}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
    } finally {
      await again?.stop();
      await relay.stop();
    }
  });

  it('holds a host for everyone over devices from five client addresses, not from four', async () => {
    for (const [addresses, status] of [[4, 200], [5, 503]] as const) {
      const relay = await startRelay({ env: { TRUST_PROXY: '1' } });
      try {
        const other = newId();
        assert.equal((await web(relay, other, `/addresses-${addresses}-other`)).status, 200);
        await throttle(relay, Array.from({ length: 20 }, (_, i) => `/addresses-${addresses}-${i}`), (i) => `198.51.100.${40 + (i % addresses)}`);
        const push = await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e2']));
        assert.equal(push.status, status, `${addresses} addresses: ${JSON.stringify(push.body)}`);
      } finally {
        await relay.stop();
      }
    }
  });

  it('still holds a host that throttles many devices of many users', async () => {
    const relay = await startRelay({ env: { TRUST_PROXY: '1' } });
    try {
      const other = newId();
      assert.equal((await web(relay, other, '/many-users-other')).status, 200);
      await throttle(relay, Array.from({ length: 20 }, (_, i) => `/many-users-${i}`), (i) => `198.51.100.${100 + i}`);
      const push = await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e2']));
      assert.equal(push.status, 503);
      assert.deepEqual(push.body, { ok: false, held: 'push-service-throttle' });
      assert.equal(service.to('/many-users-other').length, 0);
    } finally {
      await relay.stop();
    }
  });

  it('forwards no more to one endpoint than its own budget, however many ids share it', async () => {
    const relay = await startRelay();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await web(relay, id, '/shared-endpoint')).status, 200);
      }
      const held: unknown[] = [];
      for (const id of ids) {
        for (let i = 0; i < 10; i++) {
          const res = await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`e${i}`]));
          if (res.status !== 200) {
            assert.equal(res.status, 429);
            held.push(res.body);
          }
        }
      }
      // Each id may have ten at once; the endpoint thirty in all.
      assert.equal(service.to('/shared-endpoint').length, 30);
      assert.equal(held.length, 20);
      assert.deepEqual(held[0], { ok: false, held: 'endpoint-rate-limit' });
      // Another endpoint is not held by it.
      const other = newId();
      assert.equal((await web(relay, other, '/shared-endpoint-other')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e1']))).status, 200);
    } finally {
      await relay.stop();
    }
  });

  // A letter and its percent-encoding are the same path to the server that gets the request
  // (RFC 3986, 6.2.2.2), and the relay counts them as one endpoint, though the URL parser keeps
  // them apart. The relay here can't tell client addresses apart (no TRUST_PROXY, a loopback
  // peer), as behind a proxy it wasn't told about.
  it('cannot put its push service on hold for everyone once each spelling of its path has delivered a push', async () => {
    const relay = await startRelay();
    try {
      const web = (id: string, pathname: string) =>
        postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url(pathname), keys: makeDevice().keys } });
      const victim = newId();
      assert.equal((await web(victim, '/honest-device-p')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e1']))).status, 200);
      const word = 'abcdefghijklmnopqrstuvwxyz';
      const spellings = Array.from({ length: 20 }, (_, i) => `/one-endpoint/${word.slice(0, i)}%${word.charCodeAt(i).toString(16)}${word.slice(i + 1)}`);
      const ids: string[] = [];
      for (const pathname of spellings) {
        const id = newId();
        ids.push(id);
        assert.equal((await web(id, pathname)).status, 200);
        assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e0']))).status, 200);
      }
      // Then the service throttles that endpoint.
      for (const pathname of spellings) service.answer(pathname, { status: 429 });
      for (const id of ids) await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', ['e1']));
      const push = await postJson(relay.base, `/api/push/jmap/${victim}`, emailPush('a', ['e2']));
      assert.equal(push.status, 200, `the honest device's push was held: ${JSON.stringify(push.body)}`);
      assert.equal(service.to('/honest-device-p').length, 2);
    } finally {
      await relay.stop();
    }
  });

  it('forwards no more to one endpoint than its own budget, however its path is written', async () => {
    const relay = await startRelay();
    try {
      const word = 'abcde';
      const spellings = Array.from({ length: 5 }, (_, i) => `/spelled-budget/${word.slice(0, i)}%${word.charCodeAt(i).toString(16)}${word.slice(i + 1)}`);
      const ids: string[] = [];
      for (const pathname of spellings) {
        const id = newId();
        ids.push(id);
        assert.equal((await web(relay, id, pathname)).status, 200);
      }
      for (const id of ids) {
        for (let i = 0; i < 10; i++) await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`e${i}`]));
      }
      // Each id may have ten at once; the endpoint thirty in all, whichever way it is written.
      assert.equal(service.requests.filter((r) => r.path.startsWith('/spelled-budget/')).length, 30);
    } finally {
      await relay.stop();
    }
  });

  it('forwards no more to one device token than its own budget, whatever else the query holds', async () => {
    // WNS, Gotify and the UnifiedPush FCM distributor keep the device in a `token` parameter.
    const relay = await startRelay();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await web(relay, id, `/w/?token=device-one&extra=${i}`)).status, 200);
      }
      for (const id of ids) {
        for (let i = 0; i < 10; i++) await postJson(relay.base, `/api/push/jmap/${id}`, emailPush('a', [`e${i}`]));
      }
      assert.equal(service.requests.filter((r) => r.path.startsWith('/w/?token=device-one')).length, 30);
      // Another device on the same path has a budget of its own.
      const other = newId();
      assert.equal((await web(relay, other, '/w/?token=device-two')).status, 200);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${other}`, emailPush('a', ['e1']))).status, 200);
    } finally {
      await relay.stop();
    }
  });
});

// Cost, measured as bytes the relay process hands to write(): on a store twice the size, the same
// twenty changes must not cost twice as much. Linux only (/proc); the repo's CI runs it, and so does
//   docker run --rm -v <worktree>:/src:ro node:22-alpine sh -c "mkdir /w && cd /src && cp -r package.json package-lock.json tsconfig.json src /w/ && cd /w && npm ci && npx tsx --test src/abuse-limits.test.ts"
describe('what a change costs as the store grows', { skip: process.platform !== 'linux' && 'needs /proc/<pid>/io' }, () => {
  async function writtenForTwentyChanges(records: number): Promise<number> {
    const dataDir = seedLegacyStore(records);
    const port: number = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const found = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(found));
      });
    });
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('src', 'server.ts')], {
      cwd: root,
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PUSH_DATA_DIR: dataDir, NODE_EXTRA_CA_CERTS: CERT_FILE, PUSH_ALLOW_PRIVATE_ENDPOINTS: 'localhost', METRICS_TOKEN: '', METRICS_TOKEN_FILE: '', PUSH_REGISTER_BURST: '1000', ...testVapid() },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; ; i++) {
        try {
          if ((await fetch(`${base}/api/health`)).ok) break;
        } catch {
          // Not listening yet.
        }
        if (i > 600) throw new Error('relay did not start');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const id = newId();
      assert.equal((await register({ base }, id, '/cost')).status, 200);
      const wchar = () => Number(/^wchar: (\d+)/m.exec(fs.readFileSync(`/proc/${child.pid}/io`, 'utf8'))![1]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const start = wchar();
      for (let i = 0; i < 20; i++) {
        assert.equal((await postJson(base, `/api/push/jmap/${id}`, pushVerification(`code-${i}`))).status, 200);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return wchar() - start;
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }

  it('writes about as much for twenty changes on 4,000 records as on 2,000', async () => {
    const small = await writtenForTwentyChanges(2_000);
    const large = await writtenForTwentyChanges(4_000);
    assert.ok(large < small * 1.5, `twenty changes wrote ${small} bytes on 2,000 records and ${large} on 4,000`);
  });
});
