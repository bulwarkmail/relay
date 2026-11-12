// A new device on a full store and a write that fails on the way: the new record is
// written before the record that gives way is deleted, so neither is lost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_RECORD_BYTES, subscriptionStore } from './store.js';
import { newId, storedRecords } from './test-support/harness.js';
import type { SubscriptionRecord } from './types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-full-'));
process.env.PUSH_DATA_DIR = dataDir;

const HOUR = 60 * 60 * 1000;
const record = (name: string, registeredAt: number): SubscriptionRecord => ({
  kind: 'up',
  endpoint: `https://push.example.org/${name}`,
  keys: null,
  verificationCode: null,
  createdAt: registeredAt,
  lastPushAt: null,
  lastRegisteredAt: registeredAt,
});

describe('a new device on a full store', () => {
  it('is written before the record that gives way is deleted, so a write that fails loses neither', async () => {
    const now = Date.now();
    const first = newId();
    const second = newId();
    assert.deepEqual(await subscriptionStore.put(first, record('first', now - 2 * HOUR), { limit: 2 }), { stored: true });
    assert.deepEqual(await subscriptionStore.put(second, record('second', now - HOUR), { limit: 2 }), { stored: true });

    // The store refuses to write the new record: the one that would have given way stays.
    await assert.rejects(subscriptionStore.put(newId(), record('x'.repeat(MAX_RECORD_BYTES), now), { limit: 2 }));
    assert.ok(await subscriptionStore.get(first), 'the record that would have given way is gone from memory');
    assert.ok(storedRecords(dataDir)[first], 'the record that would have given way is gone from the disk');

    // The disk refuses the second of the two writes a new device on a full store takes.
    const realOpen = fsp.open;
    let appends = 0;
    fsp.open = (async (file: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
      if (String(file).endsWith('subscriptions.journal') && rest[0] === 'a' && ++appends === 2) {
        throw Object.assign(new Error('ENOSPC: no space left on device, open'), { code: 'ENOSPC' });
      }
      return (realOpen as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof realOpen;
    syncBuiltinESMExports();
    const third = newId();
    let result: unknown;
    try {
      result = await subscriptionStore.put(third, record('third', now), { limit: 2 }).catch((error: Error) => error.message);
    } finally {
      fsp.open = realOpen;
      syncBuiltinESMExports();
    }
    assert.ok(await subscriptionStore.get(first), 'the record that would have given way is gone from memory');
    assert.ok(storedRecords(dataDir)[first], 'the record that would have given way is gone from the disk');
    // The new device's record went in whole: it is answered as stored, and it is on disk.
    assert.deepEqual(result, { stored: true });
    assert.ok(storedRecords(dataDir)[third]);
    // Once writes go through again, it is the next to give way.
    const fourth = newId();
    assert.deepEqual(await subscriptionStore.put(fourth, record('fourth', now), { limit: 2 }), {
      stored: true,
      evicted: { id: first, record: record('first', now - 2 * HOUR) },
    });
    assert.equal(storedRecords(dataDir)[first], undefined);
  });
});
