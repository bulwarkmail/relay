import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forwardPolicy } from './forward-policy.js';
import type { SubscriptionRecord } from './types.js';

const record = (i: number): SubscriptionRecord => ({
  kind: 'web',
  webPush: { endpoint: `https://push.example.org/endpoint-${i}`, keys: { p256dh: 'p', auth: 'a' } },
  verificationCode: null,
  createdAt: 0,
  lastPushAt: null,
});

describe('backoffs the push services asked for', () => {
  it('keeps at most ten thousand endpoints, forgetting the one that went into backoff first', () => {
    const now = Date.now();
    const throttled = { ok: false, status: 429, unregistered: false, retryAfterSeconds: 3600 };
    for (let i = 0; i <= 10_000; i++) forwardPolicy.note(record(i), throttled, null, now);
    assert.equal(forwardPolicy.hold('first', record(0), now + 1000)?.reason, undefined, 'the oldest backoff is still kept');
    assert.equal(forwardPolicy.hold('second', record(1), now + 1000)?.reason, 'push-service-backoff');
    assert.equal(forwardPolicy.hold('last', record(10_000), now + 1000)?.reason, 'push-service-backoff');
  });
});

describe('one endpoint written many ways', () => {
  let n = 0;
  const at = (endpoint: string, lastPushAt: number | null = null): SubscriptionRecord => ({
    kind: 'web',
    webPush: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
    verificationCode: null,
    createdAt: 0,
    lastPushAt,
  });

  // Whether pushes to `b` come out of the budget pushes to `a` used up. Each push has an id of
  // its own, so only the budget per endpoint can hold one back.
  function shareBudget(a: string, b: string): boolean {
    const now = Date.now();
    for (let i = 0; i < 30; i++) assert.equal(forwardPolicy.hold(`budget-${n++}`, at(a), now), null);
    return forwardPolicy.hold(`budget-${n++}`, at(b), now)?.reason === 'endpoint-rate-limit';
  }

  it('shares one budget across the spellings of an endpoint, and none between different endpoints', () => {
    const same: Array<[string, string, string]> = [
      ['an upper-case host', 'https://push-1.example.org/a', 'https://PUSH-1.Example.ORG/a'],
      ['the default port written out', 'https://push-2.example.org/a', 'https://push-2.example.org:443/a'],
      ['a trailing dot on the host', 'https://push-3.example.org/a', 'https://push-3.example.org./a'],
      ['an IPv6 literal written two ways', 'https://[2001:db8::4]/a', 'https://[2001:DB8:0:0:0:0:0:4]:443/a'],
      ['unreserved letters percent-encoded', 'https://push-5.example.org/abc', 'https://push-5.example.org/%61b%63'],
      ['the hex digits of an escape in lower case', 'https://push-6.example.org/a%2Fb', 'https://push-6.example.org/a%2fb'],
      ['dot segments', 'https://push-7.example.org/a/b', 'https://push-7.example.org/a/./x/../b'],
      ['a fragment', 'https://push-8.example.org/a', 'https://push-8.example.org/a#x'],
    ];
    for (const [what, a, b] of same) assert.equal(shareBudget(a, b), true, `${what}: two budgets`);
    const apart: Array<[string, string, string]> = [
      ['%2F and a slash', 'https://push-9.example.org/a/b', 'https://push-9.example.org/a%2Fb'],
      // WNS (Edge) endpoints differ only here: each device keeps a budget of its own.
      ['a query that differs', 'https://push-10.example.org/w/?token=1', 'https://push-10.example.org/w/?token=2'],
      ['a letter in another case', 'https://push-11.example.org/abc', 'https://push-11.example.org/aBc'],
      ['another port', 'https://push-12.example.org/a', 'https://push-12.example.org:8443/a'],
    ];
    for (const [what, a, b] of apart) assert.equal(shareBudget(a, b), false, `${what}: one budget`);
  });

  // Whether another device on the host is held once these endpoints, each of which delivered
  // before, got a 429, each registered from an address of its own.
  function holdsHost(endpoints: string[], bystander: string): boolean {
    const now = Date.now();
    const throttled = { ok: false, status: 429, unregistered: false };
    endpoints.forEach((endpoint, i) => forwardPolicy.note(at(endpoint, now - 1000), throttled, `198.51.100.${i}`, now));
    return forwardPolicy.hold(`bystander-${n++}`, at(bystander), now)?.reason === 'push-service-throttle';
  }

  it('counts an endpoint as one device toward holding its host, however it is written', () => {
    const word = 'abcdefghijklmnopqrst';
    const spellings = [
      `https://push-h.example.org/one/${word}`,
      `https://PUSH-H.example.org/one/${word}`,
      `https://push-h.example.org:443/one/${word}`,
      `https://push-h.example.org./one/${word}`,
      `https://push-h.example.org/one/${word}?n=1`,
      `https://push-h.example.org/x/../one/${word}`,
      ...Array.from({ length: 20 }, (_, i) => `https://push-h.example.org/one/${word.slice(0, i)}%${word.charCodeAt(i).toString(16)}${word.slice(i + 1)}`),
    ];
    assert.equal(holdsHost(spellings, 'https://push-h.example.org/bystander'), false, 'one endpoint written 26 ways held its host');
    // Twenty endpoints that are different devices still hold it.
    const devices = Array.from({ length: 20 }, (_, i) => `https://push-g.example.org/device-${i}`);
    assert.equal(holdsHost(devices, 'https://push-g.example.org./bystander'), true);
  });
});
