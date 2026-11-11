// A UnifiedPush endpoint registered without keys gets the payload as plain JSON, posted
// to whatever URL was registered. What a caller can put into it must not be free text.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { toForwardPayload } from './payload.js';
import { makeDevice, newId, postJson, startFakePushService, startRelay, stateChange, type FakePushService, type RunningRelay } from './test-support/harness.js';
import type { EmailPush, StateChange } from './types.js';

const change = (changed: Record<string, Record<string, string>>): StateChange => ({ '@type': 'StateChange', changed });
const TEXT = 'Free text with spaces, <b>markup</b> and a link http://evil-site.example';

describe('what a caller can put into a forwarded payload', () => {
  it('keeps the state strings a mail server sends', () => {
    const payload = toForwardPayload(change({ a1: { EmailDelivery: 'sa1b2', Email: 'n-9_x', Mailbox: '1234567890' } }), 'alice@example.org');
    assert.deepEqual(payload.changed, { a1: { EmailDelivery: 'sa1b2', Email: 'n-9_x', Mailbox: '1234567890' } });
    assert.equal(payload.accountLabel, 'alice@example.org');
    // The legacy proxy's states.
    assert.deepEqual(toForwardPayload(change({ a1: { Email: 'g12r3456' } }), '').changed, { a1: { Email: 'g12r3456' } });
  });

  it('does not forward a state that is text rather than a state', () => {
    const payload = toForwardPayload(change({ a1: { EmailDelivery: TEXT, Email: 'ok1' } }), 'alice@example.org');
    assert.ok(!JSON.stringify(payload).includes('evil-site.example'), JSON.stringify(payload));
    assert.ok(!JSON.stringify(payload).includes('<b>'));
    // The ping itself survives: the account still has a change to announce.
    assert.equal(payload.accountId, 'a1');
    assert.equal(payload.changed.a1.Email, 'ok1');
  });

  it('does not forward a state longer than a state gets', () => {
    const payload = toForwardPayload(change({ a1: { EmailDelivery: 'x'.repeat(255), Email: 'ok1' } }), '');
    const state = payload.changed.a1?.EmailDelivery ?? '';
    assert.ok(state.length <= 64, `a state of ${state.length} characters went out`);
  });

  it('leaves a caller little room in the whole payload', () => {
    const changed: Record<string, Record<string, string>> = {};
    for (const account of ['a', 'b', 'c']) changed[account] = Object.fromEntries(['EmailDelivery', 'Email', 'Mailbox', 'Thread', 'Calendar'].map((type) => [type, TEXT.repeat(4).slice(0, 255)]));
    const body = JSON.stringify(toForwardPayload(change(changed), 'x'));
    assert.ok(!body.includes('Free text'), `${body.length} bytes, with the caller's text in it`);
  });

  it('takes a state of 64 characters and leaves out one of 65, or one with a dot or a colon', () => {
    const payload = toForwardPayload(change({ a1: { Email: 'x'.repeat(64), Mailbox: 'y'.repeat(65), Thread: 's.1', Calendar: 's:1' } }), '');
    assert.deepEqual(payload.changed, { a1: { Email: 'x'.repeat(64) } });
  });

  it('keeps an account whose only state was left out, with nothing under it, and names it', () => {
    const payload = toForwardPayload(change({ a1: { EmailDelivery: 'not a state' } }), '');
    assert.deepEqual(payload.changed, { a1: {} });
    assert.equal(payload.accountId, 'a1');
    assert.equal(payload.kind, 'jmap-state-change');
  });

  it('sends an EmailPush with a state that is no state with an empty one, as without', () => {
    const body: EmailPush = { '@type': 'EmailPush', accountId: 'a1', emails: [{ id: 'm1' }], state: TEXT };
    const payload = toForwardPayload(body, '');
    assert.deepEqual(payload.changed, { a1: { EmailDelivery: '' } });
    assert.deepEqual(payload.emailIds, ['m1']);
  });
});

describe('the label in a plain UnifiedPush ping', () => {
  let service: FakePushService;
  let relay: RunningRelay;

  before(async () => {
    service = await startFakePushService();
    relay = await startRelay();
  });

  after(async () => {
    await relay.stop();
    await service.close();
  });

  async function sent(pathname: string, accountLabel: string, keys?: { p256dh: string; auth: string }, web = false) {
    const id = newId();
    const registered = web
      ? await postJson(relay.base, '/api/push/register/web', { subscriptionId: id, subscription: { endpoint: service.url(pathname), keys }, accountLabel })
      : await postJson(relay.base, '/api/push/register/unifiedpush', { subscriptionId: id, endpoint: service.url(pathname), keys, accountLabel });
    assert.equal(registered.status, 200);
    assert.equal((await postJson(relay.base, `/api/push/jmap/${id}`, stateChange({ a1: { EmailDelivery: 's1' } }))).status, 200);
    return service.to(pathname)[0].body;
  }

  it('goes out when it looks like a sign-in name', async () => {
    assert.equal(JSON.parse((await sent('/plain-name', 'alice.b+push@example.org')).toString()).accountLabel, 'alice.b+push@example.org');
  });

  it('goes out empty when it is any other text', async () => {
    const payload = JSON.parse((await sent('/plain-text', 'Free text, <b>markup</b>')).toString());
    assert.equal(payload.accountLabel, '');
    assert.equal(payload.accountId, 'a1');
  });

  it('is left as it was on the encrypted paths', async () => {
    for (const web of [false, true]) {
      const device = makeDevice();
      const body = await sent(web ? '/encrypted-web' : '/encrypted-up', 'Alice Example', device.keys, web);
      assert.equal(JSON.parse(device.decrypt(body)).accountLabel, 'Alice Example', web ? 'Web Push' : 'UnifiedPush with keys');
    }
  });
});
