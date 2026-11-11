// The store holds every device's push endpoint, keys and token: whoever reads it can push to all of
// them. Only the relay's own user may read it: the snapshot, its previous version, the journal, a
// half-written one, or a copy kept aside after corruption. POSIX only; the repo's CI runs it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { newId, postJson, startRelay, type RunningRelay } from './test-support/harness.js';

const posix = process.platform !== 'win32';

function othersCanRead(file: string): boolean {
  return (fs.statSync(file).mode & 0o077) !== 0;
}

const modeOf = (file: string) => (fs.statSync(file).mode & 0o777).toString(8);

const register = (relay: RunningRelay) =>
  postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: newId(), endpoint: 'https://distributor.example/x' });

describe('the store on disk', { skip: !posix && 'file modes mean nothing on Windows' }, () => {
  it('is readable by the relay user only: the snapshot, its previous version, the journal and the directory it makes', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mode-'));
    const dataDir = path.join(parent, 'data'); // not there yet: the relay creates it
    let relay = await startRelay({ dataDir, env: { PUSH_ALLOW_PRIVATE_ENDPOINTS: '' } });
    try {
      // Each stop writes a snapshot; the second moves the first to the previous version's place.
      for (let i = 0; i < 2; i++) {
        assert.equal((await register(relay)).status, 200);
        relay = await relay.restart();
      }
      assert.equal((await register(relay)).status, 200);
      for (const name of ['subscriptions.json', 'subscriptions.json.bak', 'subscriptions.journal']) {
        const file = path.join(dataDir, name);
        assert.ok(fs.existsSync(file), `${name} exists`);
        assert.equal(othersCanRead(file), false, `${name} has mode ${modeOf(file)}`);
      }
      assert.equal(othersCanRead(dataDir), false, `the data directory has mode ${modeOf(dataDir)}`);
    } finally {
      await relay.stop();
    }
  });

  it('tightens a store an earlier version left readable by everyone', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mode-old-'));
    const file = path.join(dataDir, 'subscriptions.json');
    fs.writeFileSync(file, JSON.stringify({ records: {} }), { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(`${file}.bak`, JSON.stringify({ records: {} }), { mode: 0o644 });
    fs.chmodSync(`${file}.bak`, 0o644);
    const relay = await startRelay({ dataDir, env: { PUSH_ALLOW_PRIVATE_ENDPOINTS: '' } });
    try {
      await register(relay);
      for (const name of fs.readdirSync(dataDir)) {
        assert.equal(othersCanRead(path.join(dataDir, name)), false, `${name} has mode ${modeOf(path.join(dataDir, name))}`);
      }
    } finally {
      await relay.stop();
    }
  });

  it('narrows a data directory open to others, and says so once', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mode-dir-'));
    fs.chmodSync(dataDir, 0o755);
    const relay = await startRelay({ dataDir, env: { PUSH_ALLOW_PRIVATE_ENDPOINTS: '' } });
    try {
      await register(relay);
      await register(relay);
      assert.equal(othersCanRead(dataDir), false, `the data directory has mode ${modeOf(dataDir)}`);
      assert.equal(relay.logs().split('the data directory was open to other users').length - 1, 1);
    } finally {
      await relay.stop();
    }
  });

  it('keeps a corrupt store it moved aside private too', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mode-corrupt-'));
    fs.writeFileSync(path.join(dataDir, 'subscriptions.json'), '{"records": {"aaaaaaaaaaaaaaaa": {"kind":"web"', { mode: 0o644 });
    const relay = await startRelay({ dataDir });
    try {
      const aside = fs.readdirSync(dataDir).find((name) => name.includes('.corrupt-'));
      assert.ok(aside, 'the corrupt file was kept aside');
      assert.equal(othersCanRead(path.join(dataDir, aside)), false, `${aside} has mode ${modeOf(path.join(dataDir, aside))}`);
    } finally {
      await relay.stop();
    }
  });
});
