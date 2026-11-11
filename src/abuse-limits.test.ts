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
  blockStoreWrites,
  emailPush,
  getJson,
  makeDevice,
  newId,
  postJson,
  pushVerification,
  seedStore,
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
      assert.equal((await register(relay, newId(), '/limits')).status, 507);
    } finally {
      await relay.stop();
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
