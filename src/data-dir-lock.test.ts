// One data directory, one relay. The relay holding it refreshes its lock every
// fifth of PUSH_LOCK_STALE_MS. A start that finds a lock refreshed within that time
// doesn't start and says how long ago it was refreshed; one that finds an older
// lock (its relay was killed) takes it over. A relay whose lock another one has
// taken over stops writing and exits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeDevice, newId, postJson, startFakePushService, startRelay, storedRecords, type FakePushService, type RunningRelay } from './test-support/harness.js';

const LOCK = 'subscriptions.lock';
// Short, so the tests don't wait long; the relay refreshes every 300 ms then. A
// start judges a lock by its own setting, and one that is to find a lock fresh
// gets a long one: starting the relay takes longer than 1.5 s on a busy machine.
const STALE_MS = 1500;
const PATIENT_MS = 30_000;

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const start = (dataDir?: string, staleMs = STALE_MS) => startRelay({ dataDir, env: { PUSH_LOCK_STALE_MS: String(staleMs) } });
const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'));

async function register(relay: RunningRelay, id = newId()) {
  const res = await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/lock'), keys: makeDevice().keys } });
  assert.equal(res.status, 200);
  return id;
}

const isKnown = async (relay: RunningRelay, id: string) => (await fetch(`${relay.base}/api/push/active/${id}`)).status === 200;

async function startFails(dataDir: string): Promise<string> {
  let started: RunningRelay | null = null;
  try {
    started = await start(dataDir, PATIENT_MS);
  } catch (error) {
    return (error as Error).message;
  }
  await started.stop();
  assert.fail('a second relay started on the directory');
}

/** How long ago the refused start says the lock was refreshed, in seconds. */
function refreshedAgo(reason: string): number {
  const match = /"refreshedSecondsAgo":([\d.]+)/.exec(reason);
  assert.ok(match, `the refusal doesn't say how old the lock is: ${reason}`);
  return Number(match[1]);
}

async function exitsWithin(relay: RunningRelay, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!relay.exited() && Date.now() < deadline) await sleep(50);
  return relay.exited();
}

function writeLock(dataDir: string, text: string, ageMs: number): void {
  const file = path.join(dataDir, LOCK);
  fs.writeFileSync(file, text);
  const at = (Date.now() - ageMs) / 1000;
  fs.utimesSync(file, at, at);
}

describe('the data directory of a running relay', () => {
  it('keeps a second relay out while the first refreshes its lock, and the refusal says how old the lock is', async () => {
    const first = await start();
    try {
      const id = await register(first);
      const lock = path.join(first.dataDir, LOCK);
      const before = fs.statSync(lock).mtimeMs;
      // Longer than the stale time: only the refreshes keep the lock fresh.
      await sleep(STALE_MS + 500);
      assert.ok(fs.statSync(lock).mtimeMs > before, 'the lock was not refreshed');
      const reason = await startFails(first.dataDir);
      assert.match(reason, /another relay holds this data directory/);
      assert.ok(refreshedAgo(reason) < STALE_MS / 1000, reason);
      // The first relay goes on as before.
      assert.ok(await isKnown(first, id));
      assert.ok(await isKnown(first, await register(first)));
    } finally {
      await first.stop();
    }
  });

  it('keeps a start out right after its relay was killed, and lets one in once the lock has gone stale', async () => {
    const first = await start();
    const id = await register(first);
    await first.stop('SIGKILL', { keepLock: true });
    assert.ok(fs.existsSync(path.join(first.dataDir, LOCK)), 'a killed relay left no lock, so this proves nothing');
    const reason = await startFails(first.dataDir);
    assert.ok(refreshedAgo(reason) < PATIENT_MS / 1000, reason);
    await sleep(STALE_MS + 300);
    const again = await start(first.dataDir);
    try {
      assert.ok(await isKnown(again, id));
      assert.match(again.logs(), /took over subscriptions\.lock/);
    } finally {
      await again.stop();
    }
  });

  it('runs exactly one of two relays that start at the same moment, on no lock and on a stale one', async () => {
    for (const stale of [false, true]) {
      for (let round = 0; round < 3; round++) {
        const dataDir = newDir();
        if (stale) writeLock(dataDir, JSON.stringify({ token: 'an-earlier-run', pid: 1, host: 'elsewhere', startedAt: 0 }), 60_000);
        const results = await Promise.allSettled([start(dataDir), start(dataDir)]);
        const running = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
        try {
          assert.equal(running.length, 1, `${running.length} relays run on one directory (${stale ? 'stale lock' : 'no lock'})`);
          const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
          assert.match(String(refused.reason), /another relay holds this data directory/);
        } finally {
          for (const relay of running) await relay.stop();
        }
      }
    }
  });

  it('stops writing and exits once another relay has taken its lock over', async () => {
    const relay = await start();
    try {
      const first = await register(relay);
      // What a start that found the lock stale leaves: a lock with another token.
      writeLock(relay.dataDir, JSON.stringify({ token: 'another-relay', pid: 1, host: 'elsewhere', startedAt: Date.now() }), 0);
      const second = newId();
      const answer = await postJson(relay.base, '/api/push/register/web', { subscriptionId: second, subscription: { endpoint: service.url('/lock'), keys: makeDevice().keys } }).catch(() => null);
      assert.notEqual(answer?.status, 200, 'it took a change after losing its lock');
      assert.ok(await exitsWithin(relay, 3000), 'it kept running');
      assert.equal(relay.exitCode(), 1);
      assert.match(relay.logs(), /another relay took over subscriptions\.lock, so this one stops writing and exits/);
      const records = storedRecords(relay.dataDir);
      assert.ok(records[first]);
      assert.equal(records[second], undefined, 'the change went to disk');
    } finally {
      await relay.stop();
    }
  });

  it('takes over a stale lock it cannot read, and keeps out of a fresh one', async () => {
    const dataDir = newDir();
    writeLock(dataDir, '{"tok', 0);
    assert.match(await startFails(dataDir), /another relay holds this data directory/);
    writeLock(dataDir, '{"tok', STALE_MS + 1000);
    const relay = await start(dataDir);
    try {
      assert.ok(await isKnown(relay, await register(relay)));
    } finally {
      await relay.stop();
    }
  });

  // A stop is a kill on Windows; a clean stop happens where the relay gets SIGTERM.
  it('is given up when the relay stops cleanly', { skip: process.platform === 'win32' && 'a stop kills the process on Windows' }, async () => {
    const relay = await start();
    assert.ok(fs.existsSync(path.join(relay.dataDir, LOCK)));
    assert.equal(await relay.stop('SIGTERM', { keepLock: true }), 0);
    assert.ok(!fs.existsSync(path.join(relay.dataDir, LOCK)), 'a clean stop left the lock');
  });

  // SIGSTOP and SIGCONT pause a process the way a suspended machine or a long stall does.
  it('carries on after a pause when nobody took its lock, and stops when somebody did', { skip: process.platform === 'win32' && 'no SIGSTOP on Windows' }, async () => {
    const relay = await start();
    let other: RunningRelay | null = null;
    try {
      process.kill(relay.pid, 'SIGSTOP');
      await sleep(STALE_MS + 500);
      process.kill(relay.pid, 'SIGCONT');
      await sleep(800);
      assert.ok(!relay.exited(), 'it stopped although its lock was still its own');
      assert.ok(await isKnown(relay, await register(relay)));

      process.kill(relay.pid, 'SIGSTOP');
      await sleep(STALE_MS + 500);
      other = await start(relay.dataDir);
      process.kill(relay.pid, 'SIGCONT');
      assert.ok(await exitsWithin(relay, 3000), 'the paused relay kept running next to the one that took over');
      assert.equal(relay.exitCode(), 1);
      assert.ok(await isKnown(other, await register(other)));
    } finally {
      if (!relay.exited()) process.kill(relay.pid, 'SIGCONT');
      await other?.stop();
      await relay.stop();
    }
  });
});
