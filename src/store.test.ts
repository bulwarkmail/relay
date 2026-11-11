import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { subscriptionStore } from './store.js';
import { seedStore, storedRecords } from './test-support/harness.js';

const DAY = 24 * 60 * 60 * 1000;

describe('the expiry sweep', () => {
  it('drops records that expired while the relay ran, from memory and from the disk', async () => {
    const now = Date.now();
    const record = (fields: Record<string, unknown>) => ({
      kind: 'up',
      endpoint: 'https://push.example.org/x',
      keys: null,
      verificationCode: null,
      createdAt: now,
      lastPushAt: null,
      lastRegisteredAt: now,
      ...fields,
    });
    const dataDir = seedStore({ neverused1: record({}), delivered1: record({ lastPushAt: now }) });
    process.env.PUSH_DATA_DIR = dataDir;
    await subscriptionStore.load();
    assert.equal(await subscriptionStore.size(), 2);
    assert.equal(await subscriptionStore.sweep(now + 6 * DAY), 0, 'nothing is due after six days');
    assert.equal(await subscriptionStore.sweep(now + 8 * DAY), 1, 'the record that never worked is due after seven');
    assert.equal(await subscriptionStore.size(), 1);
    assert.deepEqual(Object.keys(storedRecords(dataDir)), ['delivered1']);
    assert.equal(await subscriptionStore.sweep(now + 91 * DAY), 1, 'the other one after ninety');
    assert.equal(await subscriptionStore.size(), 0);
    assert.deepEqual(storedRecords(dataDir), {});
  });
});
