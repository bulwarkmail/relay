// When subscriptions.json can't be read, a start falls back to the previous
// version, subscriptions.json.bak. The journal is replayed onto it only when it
// continues exactly that version: its first line names the number .bak was
// written with. A journal that continues a later snapshot (the one that can't be
// read) is set aside unread: the changes between .bak and that snapshot exist
// nowhere else, so replaying the rest onto .bak would make a store that never was.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { makeDevice, newId, startFakePushService, startRelay, type FakePushService, type RunningRelay } from './test-support/harness.js';

let service: FakePushService;

before(async () => {
  service = await startFakePushService();
});

after(async () => {
  await service.close();
});

const record = (name: string) => ({
  kind: 'up',
  endpoint: service.url(`/${name}`),
  keys: makeDevice().keys,
  verificationCode: null,
  createdAt: Date.now(),
  lastPushAt: Date.now(),
  lastRegisteredAt: Date.now(),
});

/** A snapshot as this relay writes it: numbered, one record per line. */
function snapshot(seq: number, records: Record<string, unknown>): string {
  const lines = Object.entries(records).map(([id, value], i) => `\n${i === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(value)}`);
  return `{"seq":${seq},"records":{${lines.join('')}\n}}`;
}

/** A journal that continues the snapshot numbered `from`. */
function journal(from: number, changes: Array<[string, unknown]>): string {
  return `\n${JSON.stringify({ from })}${changes.map(([id, value], i) => `\n${JSON.stringify({ seq: from + i + 1, id, record: value })}`).join('')}`;
}

function dataDirWith(bak: string, journalText: string): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bak-'));
  // The newer snapshot, cut off in the middle of a record.
  fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), '{"seq":9,"records":{\n"half":{"kind":"up","endp');
  fs.writeFileSync(path.join(dataDir, 'subscriptions.json.bak'), bak);
  fs.writeFileSync(path.join(dataDir, 'subscriptions.journal'), journalText);
  return dataDir;
}

const known = async (relay: RunningRelay, id: string) => (await fetch(`${relay.base}/api/push/active/${id}`)).status === 200;

describe('a start with only the previous snapshot readable', () => {
  it('replays the journal that continues the previous snapshot', async () => {
    const [kept, deleted, added] = [newId(), newId(), newId()];
    const dataDir = dataDirWith(snapshot(5, { [kept]: record('kept'), [deleted]: record('deleted') }), journal(5, [[added, record('added')], [deleted, null]]));
    const relay = await startRelay({ dataDir });
    try {
      assert.ok(await known(relay, kept));
      assert.ok(await known(relay, added), 'a change in the journal was lost');
      assert.ok(!(await known(relay, deleted)), 'a delete in the journal was lost');
      const files = fs.readdirSync(dataDir);
      assert.ok(files.some((name) => name.startsWith('subscriptions.json.corrupt-')), 'the unreadable snapshot was not kept aside');
      assert.ok(!files.some((name) => name.includes('.stale-')), 'the journal was set aside');
    } finally {
      await relay.stop();
    }
  });

  it('sets aside, unread, a journal that continues the snapshot it could not read', async () => {
    const [kept, deletedLater, addedLater] = [newId(), newId(), newId()];
    const dataDir = dataDirWith(snapshot(5, { [kept]: record('kept-2'), [deletedLater]: record('deleted-later') }), journal(9, [[addedLater, record('added-later')], [deletedLater, null]]));
    const relay = await startRelay({ dataDir });
    try {
      assert.ok(await known(relay, kept));
      // Neither change of that journal: the relay runs on the previous snapshot as it is.
      assert.ok(await known(relay, deletedLater));
      assert.ok(!(await known(relay, addedLater)));
      const aside = fs.readdirSync(dataDir).filter((name) => name.startsWith('subscriptions.journal.stale-'));
      assert.equal(aside.length, 1, 'the journal was not kept aside');
      assert.match(relay.logs(), /does not continue the snapshot/);
    } finally {
      await relay.stop();
    }
  });
});
