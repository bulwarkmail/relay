// How large one record and the whole store can get, and what loading the store takes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_RECORD_BYTES, MAX_REGISTRATION_BYTES, recordBytes, subscriptionStore } from './store.js';
import { getJson, startRelay, storedRecords } from './test-support/harness.js';
import type { SubscriptionRecord } from './types.js';

process.env.PUSH_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-size-'));

const now = Date.now();
// Every field at the limit its validator sets: an endpoint of 2,048 characters,
// keys with padding, a label of 120 characters of three bytes each.
const largestUnifiedPush = (i = 0): SubscriptionRecord => ({
  kind: 'up',
  endpoint: `https://push.example.org/${String(i).padStart(8, '0')}/${'x'.repeat(2048 - 34)}`,
  keys: { p256dh: `B${'A'.repeat(86)}=`, auth: `${'a'.repeat(22)}==` },
  verificationCode: null,
  createdAt: now,
  lastPushAt: now,
  lastRegisteredAt: now,
  codeCollectedAt: now,
  accountLabel: '€'.repeat(120),
});
// A verification code at its limit, of the character JSON writes as two.
const largestCode = '"'.repeat(512);

describe('the largest record the relay takes', () => {
  it('stays under the bound with every field and the verification code at their limits', () => {
    const fcm: SubscriptionRecord = { kind: 'fcm', fcmToken: 'f'.repeat(2048), verificationCode: null, createdAt: now, lastPushAt: now, lastRegisteredAt: now, codeCollectedAt: now, accountLabel: '€'.repeat(120) };
    for (const record of [largestUnifiedPush(), fcm]) {
      assert.ok(recordBytes(record) <= MAX_REGISTRATION_BYTES, `${record.kind}: ${recordBytes(record)} bytes`);
      assert.ok(recordBytes({ ...record, verificationCode: largestCode }) <= MAX_RECORD_BYTES, `${record.kind} with a code`);
    }
    // The heap a full store needs is measured with UnifiedPush records; no other kind is larger.
    assert.ok(
      recordBytes({ ...fcm, verificationCode: largestCode }) <= recordBytes({ ...largestUnifiedPush(), verificationCode: largestCode }),
      `the largest FCM record takes ${recordBytes({ ...fcm, verificationCode: largestCode })} bytes`,
    );
  });

  it('writes no record larger than the bound, and keeps nothing of it', async () => {
    const id = 'toolarge1';
    const record = { ...largestUnifiedPush(), endpoint: `https://push.example.org/${'x'.repeat(MAX_RECORD_BYTES)}` };
    await assert.rejects(subscriptionStore.put(id, record));
    assert.equal(await subscriptionStore.get(id), null);
    assert.equal(storedRecords(process.env.PUSH_DATA_DIR!)[id], undefined);
  });
});

describe('a store full of the largest records', () => {
  it('loads a line at a time, in a heap far smaller than the file', async () => {
    // 20,000 such records are about 76 MB as the relay writes its snapshot, one
    // record per line. Read whole, the file needs about 216 MB of heap to load;
    // a line at a time, under 100.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-size-full-'));
    const file = path.join(dataDir, 'subscriptions.json');
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, '{"seq":1,"records":{');
    for (let i = 0; i < 20_000; i++) {
      fs.writeSync(fd, `\n${i === 0 ? '' : ','}"id${String(i).padStart(14, '0')}":${JSON.stringify({ ...largestUnifiedPush(i), verificationCode: largestCode })}`);
    }
    fs.writeSync(fd, '\n}}');
    fs.closeSync(fd);
    assert.ok(fs.statSync(file).size > 70 * 1024 * 1024);
    const relay = await startRelay({ dataDir, env: { NODE_OPTIONS: '--max-old-space-size=128' } });
    try {
      assert.equal((await getJson(relay.base, '/api/push/active/id00000000019999')).status, 200);
    } finally {
      await relay.stop('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
