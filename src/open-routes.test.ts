// The health route says that the relay is up and nothing else. The number of records is for
// whoever holds the metrics token.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getJson, newId, postJson, startFakePushService, startRelay } from './test-support/harness.js';

const METRICS_TOKEN = 'scrape-secret-0123456789';

describe('what the open routes tell a stranger', () => {
  it('answers the health check with ok and no count, with records or without', async () => {
    const service = await startFakePushService();
    const relay = await startRelay({ env: { METRICS_TOKEN } });
    try {
      assert.deepEqual((await getJson(relay.base, '/api/health')).body, { ok: true });
      for (let i = 0; i < 3; i++) {
        assert.equal((await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: newId(), endpoint: service.url('/health') })).status, 200);
      }
      const health = await getJson(relay.base, '/api/health');
      assert.equal(health.status, 200);
      assert.deepEqual(health.body, { ok: true }, 'the health route still tells how many records there are');
      // The landing page in its JSON form names routes only.
      const landing = await fetch(`${relay.base}/`, { headers: { accept: 'application/json' } });
      assert.ok(!/\d+\s*subscriptions|"subscriptions"/.test(await landing.text()));
      // The count is still there for the operator.
      const metrics = await fetch(`${relay.base}/metrics`, { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
      assert.equal(metrics.status, 200);
      assert.match(await metrics.text(), /^relay_subscriptions_active\{transport="up"\} 3$/m);
    } finally {
      await relay.stop();
      await service.close();
    }
  });
});
