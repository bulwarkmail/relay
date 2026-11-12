// One data directory, one relay: a second relay started on a directory a running
// relay holds doesn't start, and says why. A lock left behind by a relay that was
// killed doesn't keep the next one from starting.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { LockHolder } from './store.js';
import { makeDevice, newId, postJson, startFakePushService, startRelay, type FakePushService, type RunningRelay } from './test-support/harness.js';

const LOCK = 'subscriptions.lock';

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

async function register(relay: RunningRelay, id = newId()) {
  const res = await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url('/lock'), keys: makeDevice().keys } });
  assert.equal(res.status, 200);
  return id;
}

const isKnown = async (relay: RunningRelay, id: string) => (await fetch(`${relay.base}/api/push/active/${id}`)).status === 200;

/** The number of a process that has ended. */
function endedPid(): number {
  const ended = spawnSync(process.execPath, ['-e', '']);
  assert.ok(ended.pid);
  return ended.pid;
}

async function startFails(dataDir: string): Promise<string> {
  let started: RunningRelay | null = null;
  try {
    started = await startRelay({ dataDir });
  } catch (error) {
    return (error as Error).message;
  }
  await started.stop();
  assert.fail('a second relay started on the directory');
}

describe('the data directory of a running relay', () => {
  it('keeps a second relay from starting, which says why, and stays as it was', async () => {
    const first = await startRelay();
    try {
      const id = await register(first);
      const reason = await startFails(first.dataDir);
      assert.match(reason, /another relay holds this data directory/);
      assert.match(reason, /subscriptions\.lock/);
      assert.ok(reason.includes(JSON.stringify(os.hostname())), 'the message does not say where the other relay runs');
      // The first relay goes on as before.
      assert.ok(await isKnown(first, id));
      const next = await register(first);
      assert.ok(await isKnown(first, next));
    } finally {
      await first.stop();
    }
  });

  it('is taken over from a relay that was killed', async () => {
    const first = await startRelay();
    const id = await register(first);
    await first.stop('SIGKILL');
    assert.ok(fs.existsSync(path.join(first.dataDir, LOCK)), 'a killed relay left no lock, so this proves nothing');
    const again = await startRelay({ dataDir: first.dataDir });
    try {
      assert.ok(await isKnown(again, id));
      assert.match(again.logs(), /took over subscriptions\.lock/);
    } finally {
      await again.stop();
    }
  });

  it('is taken over from a process number nobody has, and from a lock that is not one', async () => {
    for (const text of [
      JSON.stringify({ pid: endedPid(), host: os.hostname(), startedAt: Date.now() - 60_000 }),
      '{"pid":',
      '',
    ]) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-'));
      fs.writeFileSync(path.join(dataDir, LOCK), text);
      const relay = await startRelay({ dataDir });
      try {
        assert.ok(await isKnown(relay, await register(relay)));
      } finally {
        await relay.stop();
      }
    }
  });

  it('counts as held when another host wrote the lock, since its process cannot be checked from here', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-lock-host-'));
    fs.writeFileSync(path.join(dataDir, LOCK), JSON.stringify({ pid: 1, host: 'some-other-host', startedAt: Date.now() }));
    const reason = await startFails(dataDir);
    assert.match(reason, /some-other-host/);
    // Once the operator has removed it, the relay starts.
    fs.rmSync(path.join(dataDir, LOCK));
    const relay = await startRelay({ dataDir });
    await relay.stop();
  });

  // A stop is a kill on Windows; a clean stop happens where the relay gets SIGTERM.
  it('is given up when the relay stops cleanly', { skip: process.platform === 'win32' && 'a stop kills the process on Windows' }, async () => {
    const relay = await startRelay();
    assert.ok(fs.existsSync(path.join(relay.dataDir, LOCK)));
    assert.equal(await relay.stop('SIGTERM'), 0);
    assert.ok(!fs.existsSync(path.join(relay.dataDir, LOCK)), 'a clean stop left the lock');
  });
});

describe('whether the relay that wrote a lock may still run', () => {
  it('goes by its process on this host, and says yes when it cannot tell', async () => {
    const { currentLockHolder, lockHolderRuns } = await import('./store.js');
    const me = await currentLockHolder();
    const holder = (fields: Partial<LockHolder>): LockHolder => ({ ...me, startedAt: me.startedAt - 1000, ...fields });
    const waiting = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      assert.ok(waiting.pid);
      // An earlier run with this process's own number: a relay in a new container gets the same one.
      assert.equal(await lockHolderRuns(holder({}), me), false);
      assert.equal(await lockHolderRuns(holder({ pid: endedPid(), start: undefined }), me), false);
      assert.equal(await lockHolderRuns(holder({ pid: waiting.pid, start: undefined }), me), true);
      assert.equal(await lockHolderRuns(holder({ pid: waiting.pid, host: 'some-other-host' }), me), true);
      assert.equal(await lockHolderRuns(holder({ pid: endedPid(), host: 'some-other-host' }), me), true, 'another host is checked by number');
      // The machine has restarted since: no process of that boot runs.
      assert.equal(await lockHolderRuns(holder({ pid: waiting.pid, boot: 'an-earlier-boot' }), { ...me, boot: 'this-boot' }), false);
      if (me.start !== undefined) {
        // Linux: a process that has the number but started at another time got the number later.
        assert.equal(await lockHolderRuns(holder({ pid: waiting.pid, start: '1' }), me), false);
      }
    } finally {
      waiting.kill();
    }
  });
});
