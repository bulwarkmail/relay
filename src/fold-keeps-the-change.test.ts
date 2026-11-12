// The change that makes the journal outgrow its limit is on disk like any other:
// the store folds the journal into a new snapshot while that change is being
// made, and the snapshot has to hold it. So is every other answered change,
// wherever a crash cuts a fold short, and a journal that doesn't continue the
// snapshot next to it is not replayed over it.
//
// The journal is folded once it is larger than the snapshot and larger than 1 MiB.
// The first cases fill a fresh store's journal to just under 1 MiB and then make
// one more change, which is the one that triggers the fold. On a fresh store the
// first change writes a snapshot that holds no change yet (number 0) before the
// journal begins; a fold writes one with the number of the last change it holds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  getJson,
  makeDevice,
  newId,
  postJson,
  pushVerification,
  seedStore,
  startFakePushService,
  startRelay,
  stateChange,
  storedRecords,
  type FakePushService,
  type RunningRelay,
} from './test-support/harness.js';

const FOLD_AT = 1024 * 1024;
const METRICS_TOKEN = 'scrape-secret-0123456789';
// The store's files, which the crash cases put together by hand.
const SNAPSHOT = 'subscriptions.json';
const JOURNAL = 'subscriptions.journal';

let service: FakePushService;
const keys = makeDevice().keys;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

const journalSize = (dataDir: string) => {
  try {
    return fs.statSync(path.join(dataDir, 'subscriptions.journal')).size;
  } catch {
    return 0;
  }
};

/** The number of the last change the snapshot holds; null without a snapshot or a number. */
function snapshotSeq(dataDir: string): number | null {
  try {
    const head = /^\{"seq":(\d+),/.exec(fs.readFileSync(path.join(dataDir, SNAPSHOT), 'utf8').slice(0, 40));
    return head ? Number(head[1]) : null;
  } catch {
    return null;
  }
}

/** Waits for the snapshot a fold of the journal writes. A store may fold a moment after it answers. */
async function folded(dataDir: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if ((snapshotSeq(dataDir) ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const register = (relay: RunningRelay, id: string, pathname: string) =>
  postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url(pathname), keys });

/** Fills the journal so that it ends `room` bytes under the size at which it is folded. */
async function fillJournal(relay: RunningRelay, room: number): Promise<void> {
  // What a line holds besides its path, measured on the line before the next: a
  // line may also hold a number that grows, and the first one more than that.
  let overhead = 0;
  // A line of this many bytes.
  const line = async (bytes: number) => {
    const before = journalSize(relay.dataDir);
    const pathLength = Math.max(1, bytes - overhead);
    assert.equal((await register(relay, newId(), `/fill/${'x'.repeat(pathLength)}`)).status, 200);
    overhead = journalSize(relay.dataDir) - before - pathLength;
  };
  await line(1);
  await line(1);
  const left = () => FOLD_AT - room - journalSize(relay.dataDir);
  while (left() >= 2 * (overhead + 1500)) await line(overhead + 1499);
  // The last two are cut to fit.
  await line(Math.floor(left() / 2));
  await line(left());
  assert.equal(journalSize(relay.dataDir), FOLD_AT - room, 'the journal is not where the test needs it');
  assert.equal(snapshotSeq(relay.dataDir), 0, 'the store folded before the change under test');
}

describe('the change that makes the store fold its journal', () => {
  it('is on disk when it is a registration, and there after a restart', async () => {
    const relay = await startRelay();
    try {
      await fillJournal(relay, 20);
      const id = newId();
      assert.equal((await register(relay, id, '/the-one-that-folds')).status, 200);
      assert.ok(await folded(relay.dataDir), 'this registration did not make the store fold');
      assert.ok(storedRecords(relay.dataDir)[id], 'a registration answered 200 is in neither the snapshot nor the journal');
      await relay.stop('SIGKILL');
      const again = await startRelay({ dataDir: relay.dataDir });
      try {
        assert.equal((await getJson(again.base, `/api/push/active/${id}`)).status, 200, 'a registration answered 200 was gone after a restart');
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop('SIGKILL');
    }
  });

  it('moves a device to its new endpoint on disk too', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      assert.equal((await register(relay, id, '/old-endpoint')).status, 200);
      await fillJournal(relay, 20);
      assert.equal((await register(relay, id, '/new-endpoint')).status, 200);
      assert.ok(await folded(relay.dataDir), 'this registration did not make the store fold');
      assert.equal(storedRecords(relay.dataDir)[id].endpoint, service.url('/new-endpoint'), 'the disk still has the endpoint from before');
    } finally {
      await relay.stop('SIGKILL');
    }
  });

  it('stays deleted when it is a delete', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      assert.equal((await register(relay, id, '/to-delete')).status, 200);
      await fillJournal(relay, 20);
      assert.equal((await getJson(relay.base, `/api/push/register/${id}`, 'DELETE')).status, 200);
      assert.ok(await folded(relay.dataDir), 'this delete did not make the store fold');
      assert.equal(storedRecords(relay.dataDir)[id], undefined, 'a record deleted with 200 is still on disk');
      await relay.stop('SIGKILL');
      const again = await startRelay({ dataDir: relay.dataDir });
      try {
        assert.equal((await getJson(again.base, `/api/push/active/${id}`)).status, 404, 'a deleted record was back after a restart');
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop('SIGKILL');
    }
  });

  it('keeps the verification code when it is one', async () => {
    const relay = await startRelay();
    try {
      const id = newId();
      assert.equal((await register(relay, id, '/code')).status, 200);
      await fillJournal(relay, 20);
      assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, pushVerification('q7Hn2LmXc9PzT4vBw1RkYd8JsG5uAe0F'))).status, 200);
      assert.ok(await folded(relay.dataDir), 'this code did not make the store fold');
      assert.equal(storedRecords(relay.dataDir)[id].verificationCode, 'q7Hn2LmXc9PzT4vBw1RkYd8JsG5uAe0F', 'the code is not on disk');
      await relay.stop('SIGKILL');
      const again = await startRelay({ dataDir: relay.dataDir });
      try {
        assert.deepEqual((await getJson(again.base, `/api/push/verify/${id}`)).body, { verificationCode: 'q7Hn2LmXc9PzT4vBw1RkYd8JsG5uAe0F' });
      } finally {
        await again.stop();
      }
    } finally {
      await relay.stop('SIGKILL');
    }
  });
});

const plain = (relay: RunningRelay, id: string, pathname: string) =>
  postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url(pathname) });

const read = (dataDir: string, name: string) => fs.readFileSync(path.join(dataDir, name), 'utf8');

function storeWith(files: Record<string, string>): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crash-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dataDir, name), text);
  return dataDir;
}

describe('a fold cut short by a crash', () => {
  // The files of one fold, as a relay writes them: the snapshot before, the
  // journal with three changes since (a device moved to a new endpoint, one
  // deleted, one new), and the snapshot the fold makes of them. Each case is the
  // set of files a kill leaves at one moment of the fold.
  const moved = newId();
  const deleted = newId();
  const added = newId();
  let snapshotBefore = '';
  let journal = '';
  let snapshotAfter = '';

  before(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-crash-'));
    let relay = await startRelay({ dataDir });
    assert.equal((await plain(relay, moved, '/crash-old')).status, 200);
    assert.equal((await plain(relay, deleted, '/crash-deleted')).status, 200);
    await relay.stop('SIGKILL');
    // A start that finds a journal folds it: this is the snapshot before.
    relay = await startRelay({ dataDir });
    await relay.stop('SIGKILL');
    snapshotBefore = read(dataDir, SNAPSHOT);
    relay = await startRelay({ dataDir });
    assert.equal((await plain(relay, moved, '/crash-new')).status, 200);
    assert.equal((await getJson(relay.base, `/api/push/register/${deleted}`, 'DELETE')).status, 200);
    assert.equal((await plain(relay, added, '/crash-added')).status, 200);
    await relay.stop('SIGKILL');
    assert.equal(read(dataDir, SNAPSHOT), snapshotBefore, 'the store folded before the crash cases');
    journal = read(dataDir, JOURNAL);
    // What the fold of that journal writes.
    const folded = storeWith({ [SNAPSHOT]: snapshotBefore, [JOURNAL]: journal });
    relay = await startRelay({ dataDir: folded });
    await relay.stop('SIGKILL');
    snapshotAfter = read(folded, SNAPSHOT);
    assert.notEqual(snapshotAfter, snapshotBefore);
  });

  async function assertEveryChange(dataDir: string) {
    const relay = await startRelay({ dataDir });
    try {
      const atNew = service.to('/crash-new').length;
      const atOld = service.to('/crash-old').length;
      assert.equal((await postJson(relay.base, `/api/push/jmap/${moved}`, stateChange({ a: { EmailDelivery: 's1' } }))).status, 200);
      assert.equal(service.to('/crash-new').length, atNew + 1, 'the device is not at its new endpoint');
      assert.equal(service.to('/crash-old').length, atOld, 'the push went to the endpoint the device left');
      assert.equal((await getJson(relay.base, `/api/push/active/${deleted}`)).status, 404, 'a deleted record is back');
      assert.equal((await getJson(relay.base, `/api/push/active/${added}`)).status, 200, 'a new record is gone');
      assert.ok(!fs.readdirSync(dataDir).some((name) => name.includes('stale')), 'a journal of this snapshot was set aside');
    } finally {
      await relay.stop('SIGKILL');
    }
  }

  it('keeps every change when killed after the journal took the last one, before the fold', async () => {
    await assertEveryChange(storeWith({ [SNAPSHOT]: snapshotBefore, [JOURNAL]: journal }));
  });

  it('keeps every change when killed after the new snapshot was written, before its rename', async () => {
    await assertEveryChange(storeWith({ [SNAPSHOT]: snapshotBefore, [JOURNAL]: journal, [`${SNAPSHOT}.tmp`]: snapshotAfter }));
  });

  it('keeps every change when killed after the old snapshot became the previous version', async () => {
    await assertEveryChange(storeWith({ [`${SNAPSHOT}.bak`]: snapshotBefore, [`${SNAPSHOT}.tmp`]: snapshotAfter, [JOURNAL]: journal }));
  });

  it('applies nothing twice when killed after the rename, before the journal went', async () => {
    await assertEveryChange(storeWith({ [SNAPSHOT]: snapshotAfter, [`${SNAPSHOT}.bak`]: snapshotBefore, [JOURNAL]: journal }));
  });

  it('sets aside a journal left from before an older relay wrote the snapshot, instead of replaying it', async () => {
    // Back to an older relay after a crash: it reads subscriptions.json only, keeps
    // the record the journal deleted, never hears of the new one, and moves the
    // device on once more. Then up again to this relay, with the old journal still there.
    const records = JSON.parse(snapshotBefore).records;
    records[moved] = { ...records[moved], endpoint: service.url('/crash-newer') };
    const dataDir = storeWith({ [SNAPSHOT]: JSON.stringify({ records }, null, 2), [JOURNAL]: journal });
    const relay = await startRelay({ dataDir });
    try {
      const atNewer = service.to('/crash-newer').length;
      const atNew = service.to('/crash-new').length;
      assert.equal((await postJson(relay.base, `/api/push/jmap/${moved}`, stateChange({ a: { EmailDelivery: 's1' } }))).status, 200);
      assert.equal(service.to('/crash-newer').length, atNewer + 1, 'the device was moved back to an endpoint it had left');
      assert.equal(service.to('/crash-new').length, atNew);
      assert.equal((await getJson(relay.base, `/api/push/active/${deleted}`)).status, 200, 'what the older relay kept is gone');
      assert.equal((await getJson(relay.base, `/api/push/active/${added}`)).status, 404);
      assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith(`${JOURNAL}.stale-`)).length, 1, 'the journal was not set aside');
      assert.equal(relay.logs().split('does not continue the snapshot').length - 1, 1);
    } finally {
      await relay.stop('SIGKILL');
    }
  });
});

// What the relay before the journal does on a directory: it reads subscriptions.json only and
// rewrites it whole, without a number. Written here by hand, since that relay is not in this tree.
function olderRelayWrites(dataDir: string, records: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dataDir, SNAPSHOT), JSON.stringify({ records }, null, 2));
}

describe('going back to an older relay during this relay\'s first run on a directory', () => {
  // On a store without a number (an older relay's, or none) the first change writes a snapshot of
  // this relay's own, with a number, before the journal begins. Whatever the older relay writes
  // afterwards has no number, so a journal found next to it is set aside, not replayed over it.
  for (const first of ['an empty directory', 'a store the older relay wrote']) {
    it(`does not replay the journal of that first run over what the older relay wrote since (${first})`, async () => {
      const moved = newId();
      const deleted = newId();
      const old = newId();
      const now = Date.now();
      const record = (pathname: string) => ({ kind: 'up', endpoint: service.url(pathname), keys: null, verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now });
      const dataDir = first === 'an empty directory' ? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-first-run-')) : seedStore({ [old]: record('/first-old') });
      // This relay's first run: two devices register, then the process is killed. Nothing was folded.
      const relay = await startRelay({ dataDir });
      assert.equal((await plain(relay, moved, '/first-endpoint')).status, 200);
      assert.equal((await plain(relay, deleted, '/first-deleted')).status, 200);
      await relay.stop('SIGKILL');
      assert.ok(fs.existsSync(path.join(dataDir, 'subscriptions.journal')), 'the first run left no journal');
      // Back on the older relay: it never read the journal. The device registers there with a
      // new endpoint; the other one is not known to it, which is how its user left it.
      olderRelayWrites(dataDir, { ...(first === 'an empty directory' ? {} : { [old]: record('/first-old') }), [moved]: record('/second-endpoint') });
      // Up again to this relay, the journal of the first run still there.
      const again = await startRelay({ dataDir });
      try {
        const atSecond = service.to('/second-endpoint').length;
        const atFirst = service.to('/first-endpoint').length;
        assert.equal((await postJson(again.base, `/api/push/jmap/${moved}`, stateChange({ a: { EmailDelivery: 's1' } }))).status, 200);
        assert.equal(service.to('/first-endpoint').length, atFirst, 'the device was moved back to the endpoint it had left');
        assert.equal(service.to('/second-endpoint').length, atSecond + 1);
        assert.equal((await getJson(again.base, `/api/push/active/${deleted}`)).status, 404, 'a record the older relay did not have is back');
        assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith('subscriptions.journal.stale-')).length, 1, 'the journal was not set aside');
      } finally {
        await again.stop('SIGKILL');
      }
    });

    it(`sets the journal aside as well once this relay has folded on that directory (${first})`, async () => {
      const moved = newId();
      const deleted = newId();
      const old = newId();
      const now = Date.now();
      const record = (pathname: string) => ({ kind: 'up', endpoint: service.url(pathname), keys: null, verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now });
      const dataDir = first === 'an empty directory' ? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-first-run-')) : seedStore({ [old]: record('/folded-old') });
      let relay = await startRelay({ dataDir });
      assert.equal((await plain(relay, moved, '/folded-first')).status, 200);
      await relay.stop('SIGKILL');
      // A start that finds a journal folds it into a snapshot of this relay's own.
      relay = await startRelay({ dataDir });
      assert.ok(!fs.existsSync(path.join(dataDir, JOURNAL)), 'the start did not fold the journal');
      assert.equal((await plain(relay, moved, '/folded-endpoint')).status, 200);
      assert.equal((await plain(relay, deleted, '/folded-deleted')).status, 200);
      await relay.stop('SIGKILL');
      assert.ok(fs.existsSync(path.join(dataDir, JOURNAL)), 'the second run left no journal');
      olderRelayWrites(dataDir, { ...(first === 'an empty directory' ? {} : { [old]: record('/folded-old') }), [moved]: record('/folded-second') });
      const again = await startRelay({ dataDir });
      try {
        const atSecond = service.to('/folded-second').length;
        const atEndpoint = service.to('/folded-endpoint').length;
        assert.equal((await postJson(again.base, `/api/push/jmap/${moved}`, stateChange({ a: { EmailDelivery: 's1' } }))).status, 200);
        assert.equal(service.to('/folded-endpoint').length, atEndpoint, 'the device was moved back to the endpoint it had left');
        assert.equal(service.to('/folded-second').length, atSecond + 1);
        assert.equal((await getJson(again.base, `/api/push/active/${deleted}`)).status, 404, 'a record the older relay did not have is back');
        if (first !== 'an empty directory') assert.equal((await getJson(again.base, `/api/push/active/${old}`)).status, 200);
        assert.equal(fs.readdirSync(dataDir).filter((name) => name.startsWith(`${JOURNAL}.stale-`)).length, 1, 'the journal was not set aside');
      } finally {
        await again.stop('SIGKILL');
      }
    });

    it(`replays the journal of a first run after an unclean stop when no other relay wrote the snapshot (${first})`, async () => {
      const old = newId();
      const now = Date.now();
      const dataDir = first === 'an empty directory'
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-first-run-'))
        : seedStore({ [old]: { kind: 'up', endpoint: service.url('/replay-old'), keys: null, verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now } });
      const relay = await startRelay({ dataDir });
      const ids = Array.from({ length: 200 }, () => newId());
      // Eight at a time, as page loads come in.
      for (let i = 0; i < ids.length; i += 8) {
        const statuses = await Promise.all(ids.slice(i, i + 8).map(async (id) => (await plain(relay, id, `/replay-${id}`)).status));
        assert.deepEqual(statuses, Array(statuses.length).fill(200));
      }
      // One device moves on, one leaves.
      assert.equal((await plain(relay, ids[0], '/replay-moved')).status, 200);
      assert.equal((await getJson(relay.base, `/api/push/register/${ids[1]}`, 'DELETE')).status, 200);
      await relay.stop('SIGKILL');
      const again = await startRelay({ dataDir });
      try {
        const records = storedRecords(dataDir);
        const missing = ids.slice(2).filter((id) => !records[id]);
        assert.deepEqual(missing, [], `${missing.length} answered registrations were gone after the restart`);
        assert.equal(records[ids[0]]?.endpoint, service.url('/replay-moved'), 'the device is not at its new endpoint');
        assert.equal(records[ids[1]], undefined, 'a deleted record is back');
        if (first !== 'an empty directory') assert.ok(records[old], 'the older relay\'s record is gone');
        assert.equal((await getJson(again.base, `/api/push/active/${ids[2]}`)).status, 200);
        assert.equal((await getJson(again.base, `/api/push/active/${ids[1]}`)).status, 404);
        assert.ok(!fs.readdirSync(dataDir).some((name) => name.includes('stale')), 'a journal of this snapshot was set aside');
      } finally {
        await again.stop('SIGKILL');
      }
    });
  }

  it('keeps every change it answered across a fold and a kill, on the journals before and after the fold', async () => {
    // Endpoints long enough that the journal passes the size at which it is folded on the
    // way, sixteen registrations at a time; then a kill with more of them in flight.
    const relay = await startRelay();
    const ids = Array.from({ length: 900 }, () => newId());
    const answered: string[] = [];
    let next = 0;
    let killed: Promise<unknown> | null = null;
    const worker = async () => {
      while (next < ids.length && !killed) {
        const id = ids[next++];
        const res = await register(relay, id, `/across-${id}/${'x'.repeat(1400)}`).catch(() => null);
        if (res?.status === 200) answered.push(id);
        if (answered.length >= 800 && !killed) killed = relay.stop('SIGKILL');
      }
    };
    await Promise.all(Array.from({ length: 16 }, worker));
    await killed;
    assert.ok(answered.length >= 800, `${answered.length} answered`);
    assert.ok((snapshotSeq(relay.dataDir) ?? 0) > 0, 'the journal was never folded on the way');
    const again = await startRelay({ dataDir: relay.dataDir });
    try {
      const records = storedRecords(relay.dataDir);
      const missing = answered.filter((id) => !records[id]);
      assert.deepEqual(missing, [], `${missing.length} of ${answered.length} answered registrations were gone after the restart`);
      assert.equal((await getJson(again.base, `/api/push/active/${answered.at(-1)}`)).status, 200);
      assert.ok(!fs.readdirSync(relay.dataDir).some((name) => name.includes('stale')), 'a journal of this snapshot was set aside');
    } finally {
      await again.stop('SIGKILL');
    }
  });
});

describe('an older relay between two runs of this one, whose changes end where they began', () => {
  // This relay's first run on an older relay's store: a device registers, then the process is killed
  // before any fold. Under the older relay the same device registers again and its user turns push
  // off, which leaves subscriptions.json byte for byte as the older relay had it. The first run
  // wrote a snapshot with a number before its journal, and the older relay's rewrite has none, so
  // the journal is set aside and the device stays gone.
  const rec = (pathname: string) => ({ kind: 'up', endpoint: service.url(pathname), keys, verificationCode: null, createdAt: Date.now(), lastPushAt: Date.now(), lastRegisteredAt: Date.now() });
  it('does not bring back a device its user unregistered under the older relay', async () => {
    const old = newId();
    const gone = newId();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-aba-'));
    const before = { [old]: rec('/aba-old') };
    olderRelayWrites(dir, before);
    const first = await startRelay({ dataDir: dir });
    assert.equal((await postJson(first.base, '/api/push/register/unifiedpush', { subscriptionId: gone, endpoint: service.url('/aba-gone'), keys })).status, 200);
    await first.stop('SIGKILL');
    assert.ok(fs.existsSync(path.join(dir, 'subscriptions.journal')), 'the first run left no journal');
    olderRelayWrites(dir, { ...before, [gone]: rec('/aba-gone-2') });
    olderRelayWrites(dir, before);
    const again = await startRelay({ dataDir: dir });
    try {
      const got = [
        (await getJson(again.base, `/api/push/active/${old}`)).status,
        (await getJson(again.base, `/api/push/active/${gone}`)).status,
      ];
      assert.deepEqual(got, [200, 404], 'the unregistered device is back');
    } finally {
      await again.stop('SIGKILL');
    }
  });
});

describe('the first change on a store without a number, cut short by a crash', () => {
  // The first change on an older relay's store, or on an empty directory, first writes a snapshot of
  // this relay's own: the temp file, the older snapshot moved to the previous version's place, the
  // new one renamed in. Only then does the journal take the change, and only then is it answered.
  // Each case is the set of files a kill leaves at one of those moments. The next start has every
  // record the older relay had, the change only once its journal line is whole, sets nothing aside,
  // and takes and keeps the next change.
  for (const first of ['an empty directory', 'a store the older relay wrote']) {
    describe(first, () => {
      const old = newId();
      const added = newId();
      let olderStore: string | null = null;
      let numbered = '';
      let journal = '';

      before(async () => {
        const now = Date.now();
        olderStore = first === 'an empty directory'
          ? null
          : JSON.stringify({ records: { [old]: { kind: 'up', endpoint: service.url('/first-fold-old'), keys: null, verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now } } }, null, 2);
        const dataDir = storeWith(olderStore === null ? {} : { [SNAPSHOT]: olderStore });
        const relay = await startRelay({ dataDir });
        assert.equal((await plain(relay, added, '/first-fold-added')).status, 200);
        await relay.stop('SIGKILL');
        numbered = read(dataDir, SNAPSHOT);
        journal = read(dataDir, JOURNAL);
        assert.match(numbered, /^\{"seq":0,"records":\{/, 'the first change wrote no snapshot with a number');
        assert.ok(!numbered.includes(added), 'the snapshot written before the journal holds the change');
        if (olderStore !== null) assert.equal(read(dataDir, `${SNAPSHOT}.bak`), olderStore, 'the older store is not the previous version');
      });

      const older = () => (olderStore === null ? {} : { [SNAPSHOT]: olderStore });
      const previous = () => (olderStore === null ? {} : { [`${SNAPSHOT}.bak`]: olderStore });

      async function assertStore(files: () => Record<string, string>, answered: boolean) {
        const dataDir = storeWith(files());
        const relay = await startRelay({ dataDir });
        const next = newId();
        try {
          if (olderStore !== null) assert.equal((await getJson(relay.base, `/api/push/active/${old}`)).status, 200, 'a record of the older relay is gone');
          assert.equal((await getJson(relay.base, `/api/push/active/${added}`)).status, answered ? 200 : 404, answered ? 'an answered change is gone' : 'a change that was never answered is there');
          assert.ok(!fs.readdirSync(dataDir).some((name) => name.includes('stale') || name.includes('corrupt')), 'a file was set aside');
          assert.equal((await plain(relay, next, '/first-fold-next')).status, 200);
        } finally {
          await relay.stop('SIGKILL');
        }
        const again = await startRelay({ dataDir });
        try {
          assert.equal((await getJson(again.base, `/api/push/active/${next}`)).status, 200, 'the next change is gone after a restart');
          if (olderStore !== null) assert.equal((await getJson(again.base, `/api/push/active/${old}`)).status, 200);
        } finally {
          await again.stop('SIGKILL');
        }
      }

      it('keeps the store as it was when killed while the new snapshot is written', async () => {
        await assertStore(() => ({ ...older(), [`${SNAPSHOT}.tmp`]: numbered.slice(0, Math.floor(numbered.length / 2)) }), false);
      });

      it('keeps the store as it was when killed after the new snapshot was written, before its rename', async () => {
        await assertStore(() => ({ ...older(), [`${SNAPSHOT}.tmp`]: numbered }), false);
      });

      if (first !== 'an empty directory') {
        it('keeps the store as it was when killed after the older snapshot became the previous version', async () => {
          await assertStore(() => ({ ...previous(), [`${SNAPSHOT}.tmp`]: numbered }), false);
        });
      }

      it('starts on the new snapshot when killed after its rename, before the journal began', async () => {
        await assertStore(() => ({ ...previous(), [SNAPSHOT]: numbered }), false);
      });

      it('leaves out the change when killed in the middle of the journal\'s first line', async () => {
        await assertStore(() => ({ ...previous(), [SNAPSHOT]: numbered, [JOURNAL]: journal.slice(0, 8) }), false);
      });

      it('leaves out the change when killed in the middle of its line', async () => {
        await assertStore(() => ({ ...previous(), [SNAPSHOT]: numbered, [JOURNAL]: journal.slice(0, journal.length - 12) }), false);
      });

      it('keeps the change once its journal line is whole', async () => {
        await assertStore(() => ({ ...previous(), [SNAPSHOT]: numbered, [JOURNAL]: journal }), true);
      });
    });
  }
});

describe('a change the journal could not take', () => {
  it('costs nothing of the change answered before it, also on a journal that began with a torn line', async () => {
    // A crash in the middle of a journal's very first append leaves the start of a line and
    // nothing else. The next start finds nothing to replay in it, and a refused append
    // afterwards cuts back only what that append wrote.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-torn-start-'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.journal'), '\n{"fro');
    process.env.PUSH_DATA_DIR = dataDir;
    const { subscriptionStore } = await import('./store.js');
    await subscriptionStore.load();
    const keys = makeDevice().keys;
    const now = Date.now();
    const record = (name: string) => ({ kind: 'up' as const, endpoint: `https://push.example.org/${name}`, keys, verificationCode: null, createdAt: now, lastPushAt: null, lastRegisteredAt: now });
    const answered = newId();
    assert.deepEqual(await subscriptionStore.put(answered, record('answered')), { stored: true });
    assert.ok(storedRecords(dataDir)[answered], 'the answered registration is not on disk to begin with');
    // The next append fails before it writes a byte, as on a full disk.
    const realOpen = fsp.open;
    fsp.open = (async (file: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
      if (String(file).endsWith('subscriptions.journal') && rest[0] === 'a') throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof realOpen;
    syncBuiltinESMExports();
    try {
      await assert.rejects(subscriptionStore.put(newId(), record('refused')), /ENOSPC/);
    } finally {
      fsp.open = realOpen;
      syncBuiltinESMExports();
    }
    assert.ok(storedRecords(dataDir)[answered], 'cleaning up after the refused change cut into the line of the one answered before it');
    // And the next change still goes in whole.
    const next = newId();
    assert.deepEqual(await subscriptionStore.put(next, record('next')), { stored: true });
    const records = storedRecords(dataDir);
    assert.ok(records[answered] && records[next]);
  });
});

describe('a snapshot that cannot be written', () => {
  it('is tried again a minute later, not with every change, and costs no change', async () => {
    const relay = await startRelay({ env: { METRICS_TOKEN } });
    const ids: string[] = [];
    try {
      await fillJournal(relay, 20);
      // The journal takes changes as before; only the snapshot can't be written.
      fs.mkdirSync(path.join(relay.dataDir, `${SNAPSHOT}.tmp`));
      for (let i = 0; i < 5; i++) {
        const id = newId();
        ids.push(id);
        assert.equal((await register(relay, id, `/past-the-fold-${i}`)).status, 200);
      }
      const metrics = await (await fetch(`${relay.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } })).text();
      assert.match(metrics, /^relay_store_write_failures_total 1$/m);
    } finally {
      await relay.stop('SIGKILL');
    }
    const again = await startRelay({ dataDir: relay.dataDir });
    try {
      for (const id of ids) assert.equal((await getJson(again.base, `/api/push/active/${id}`)).status, 200);
    } finally {
      await again.stop('SIGKILL');
    }
  });
});

// A stop is a kill on Windows, so this runs where the relay gets SIGTERM: Linux, as in the container.
describe('a stop while a push is on its way', { skip: process.platform === 'win32' && 'a stop kills the process on Windows' }, () => {
  it('folds the journal into subscriptions.json before the process ends', async () => {
    service.answer('/stop-slow', { status: 201, delayMs: 6500 });
    const relay = await startRelay({ env: { PUSH_FORWARD_TIMEOUT_MS: '7000' } });
    const id = newId();
    const other = newId();
    assert.equal((await plain(relay, id, '/stop-slow')).status, 200);
    assert.equal((await plain(relay, other, '/stop-other')).status, 200);
    const push = postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a: { EmailDelivery: 's1' } })).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await relay.stop();
    await push;
    assert.ok(!fs.existsSync(path.join(relay.dataDir, JOURNAL)), 'the stop left changes in the journal');
    const records = JSON.parse(read(relay.dataDir, SNAPSHOT)).records;
    assert.ok(records[id] && records[other], 'subscriptions.json misses a record');
  });
});
