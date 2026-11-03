import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isForwardableBody, toForwardPayload } from './payload.js';

describe('toForwardPayload', () => {
  it('wraps a StateChange as the legacy ping and names the first account', () => {
    const payload = toForwardPayload(
      { '@type': 'StateChange', changed: { acc1: { EmailDelivery: 's1' } } },
      'Work',
    );
    assert.deepEqual(payload, {
      kind: 'jmap-state-change',
      accountLabel: 'Work',
      accountId: 'acc1',
      emailIds: [],
      changed: { acc1: { EmailDelivery: 's1' } },
    });
  });

  it('forwards only the ids of an EmailPush, never other properties', () => {
    const payload = toForwardPayload(
      {
        '@type': 'EmailPush',
        accountId: 'acc1',
        state: 's9',
        emails: [
          { id: 'm1', threadId: 't1', subject: 'secret', from: [{ email: 'a@b' }] },
          { id: 'm2' },
          { threadId: 'no-id' },
          null as unknown as Record<string, unknown>,
        ],
      },
      undefined,
    );
    assert.deepEqual(payload, {
      kind: 'jmap-email-push',
      accountLabel: '',
      accountId: 'acc1',
      emailIds: ['m1', 'm2'],
      changed: { acc1: { EmailDelivery: 's9' } },
    });
    assert.equal(JSON.stringify(payload).includes('secret'), false);
  });

  it('synthesizes an empty state when the EmailPush carries none', () => {
    const payload = toForwardPayload(
      { '@type': 'EmailPush', accountId: 'acc1', emails: [{ id: 'm1' }] },
      '',
    );
    assert.deepEqual(payload.changed, { acc1: { EmailDelivery: '' } });
  });
});

describe('payload limits', () => {
  const body = (emails: unknown[]) => ({ '@type': 'EmailPush', accountId: 'a', emails, state: 's' }) as never;

  it('fits a push however many ids the server sent, keeping the newest', () => {
    const ids = Array.from({ length: 3000 }, (_, i) => `e${i}`);
    const payload = toForwardPayload(body(ids.map((id) => ({ id }))), 'label');
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 3000);
    assert.equal(payload.emailIds.at(-1), 'e2999');
    assert.ok(payload.emailIds.length > 100);
  });

  it('drops ids and accounts that are not JMAP ids', () => {
    const payload = toForwardPayload(body([{ id: 'good_1-A' }, { id: '<script>' }, { id: 'x'.repeat(300) }, { id: 5 }, null]), '');
    assert.deepEqual(payload.emailIds, ['good_1-A']);
    const state = toForwardPayload({
      '@type': 'StateChange',
      changed: {
        'bad id': { EmailDelivery: 's' },
        a: { EmailDelivery: 's1', 'Not A Type': 's', Email: 5, Mailbox: 'x'.repeat(300) },
        b: 'nonsense',
      },
    } as never, '');
    assert.deepEqual(state.changed, { a: { EmailDelivery: 's1' } });
    assert.equal(state.accountId, 'a');
  });

  it('fits a push however many accounts changed, keeping the ones with new mail', () => {
    const changed: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 500; i++) changed[`quiet${i}`] = { Email: `state${i}`, Mailbox: `state${i}` };
    changed.mail = { EmailDelivery: 's' };
    const payload = toForwardPayload({ '@type': 'StateChange', changed } as never, '');
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 3000);
    assert.equal(payload.changed.mail.EmailDelivery, 's');
  });

  it('names the account with new mail when others changed too', () => {
    const payload = toForwardPayload({
      '@type': 'StateChange',
      changed: { a: { Mailbox: 's' }, b: { EmailDelivery: 's' } },
    } as never, '');
    assert.equal(payload.accountId, 'b');
    assert.deepEqual(Object.keys(payload.changed), ['a', 'b']);
  });

  it('caps a long label from a record stored before the limit', () => {
    const payload = toForwardPayload({ '@type': 'StateChange', changed: { a: { EmailDelivery: 's' } } } as never, 'x'.repeat(5000));
    assert.equal(payload.accountLabel.length, 120);
  });
});

describe('isForwardableBody', () => {
  it('accepts StateChange and well-formed EmailPush bodies', () => {
    assert.equal(isForwardableBody({ '@type': 'StateChange', changed: {} }), true);
    assert.equal(isForwardableBody({ '@type': 'EmailPush', accountId: 'a', emails: [] }), true);
  });

  it('rejects verification pings, malformed EmailPush and unknown types', () => {
    assert.equal(isForwardableBody({ '@type': 'PushVerification', verificationCode: 'x' }), false);
    assert.equal(isForwardableBody({ '@type': 'EmailPush', emails: [] }), false);
    assert.equal(isForwardableBody({ '@type': 'EmailPush', accountId: 'a', emails: 'nope' }), false);
    assert.equal(isForwardableBody({ '@type': 'CalendarAlert' }), false);
    assert.equal(isForwardableBody(null), false);
  });
});
