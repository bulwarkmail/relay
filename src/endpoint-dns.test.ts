import assert from 'node:assert/strict';
import dns from 'node:dns';
import https from 'node:https';
import { afterEach, describe, it, mock } from 'node:test';
import { publicOnlyAgent } from './endpoint-guard.js';
import { sendUnifiedPush } from './unifiedpush.js';
import { sendWebPush } from './webpush.js';
import { makeDevice, testVapid } from './test-support/harness.js';
import type { ForwardPayload, UnifiedPushSubscriptionRecord, WebSubscriptionRecord } from './types.js';

// The name passes the check; what it resolves to doesn't. Nothing here leaves the machine.
function resolvesTo(address: string, family: number) {
  mock.method(dns, 'lookup', (_name: string, _options: unknown, callback: (...args: unknown[]) => void) => {
    callback(null, [{ address, family }]);
  });
}

const payload = { kind: 'jmap-state-change', accountLabel: '', accountId: 'a', emailIds: [], changed: {} } as ForwardPayload;
const base = { verificationCode: null, createdAt: 1, lastPushAt: null };

afterEach(() => mock.restoreAll());

describe('a public name that resolves to something private', () => {
  for (const [address, family] of [['127.0.0.1', 4], ['169.254.169.254', 4], ['10.1.2.3', 4], ['::1', 6], ['fd00::1', 6]] as const) {
    it(`never connects to ${address}`, async () => {
      resolvesTo(address, family);
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        const req = https.request('https://rebind.example.org/x', { agent: publicOnlyAgent, method: 'POST' }, () => resolve(new Error('connected')));
        req.on('error', resolve);
        req.end();
      });
      assert.equal(error.code, 'ENDPOINT_NOT_PUBLIC');
    });
  }

  it('keeps the record: DNS may be wrong for a moment, and the mail server tries again', async () => {
    resolvesTo('0.0.0.0', 4);
    process.env.VAPID_PUBLIC_KEY = testVapid().VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY = testVapid().VAPID_PRIVATE_KEY;
    const device = makeDevice();
    const web: WebSubscriptionRecord = { ...base, kind: 'web', webPush: { endpoint: 'https://rebind.example.org/w', keys: device.keys } };
    const up: UnifiedPushSubscriptionRecord = { ...base, kind: 'up', endpoint: 'https://rebind.example.org/u', keys: null };
    const delivery = { urgency: 'high' as const };
    for (const result of [await sendWebPush(web, payload, delivery), await sendUnifiedPush(up, payload, delivery)]) {
      assert.equal(result.ok, false);
      assert.equal(result.unregistered, false);
      assert.equal(result.status, 0);
    }
  });

  it('deletes a record whose name itself is refused: that never gets better', async () => {
    const up: UnifiedPushSubscriptionRecord = { ...base, kind: 'up', endpoint: 'https://service.internal/u', keys: null };
    const result = await sendUnifiedPush(up, payload, { urgency: 'high' });
    assert.equal(result.unregistered, true);
  });
});
