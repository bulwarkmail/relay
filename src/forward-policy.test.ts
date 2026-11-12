import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { forwardPolicy } from './forward-policy.js';
import type { SubscriptionRecord } from './types.js';
import { normalizeEndpoint } from './validation.js';

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

  // Spellings RFC 3986 keeps apart but servers route as one path, each passed through the
  // relay's own check of what a client registers.
  it('shares one budget between spellings a server may route as one path', () => {
    const cases: Array<[string, string, string]> = [
      ['double slash in the path', 'https://f1.example.org/a/b', 'https://f1.example.org/a//b'],
      ['trailing slash', 'https://f2.example.org/a/b', 'https://f2.example.org/a/b/'],
      // FCM web push tokens hold a colon: https://fcm.googleapis.com/fcm/send/<id>:APA91b...
      ['colon escaped', 'https://f3.example.org/fcm/send/x:APA91b', 'https://f3.example.org/fcm/send/x%3AAPA91b'],
      // WNS keeps the device in `token`; another parameter next to it is the same device.
      ['a parameter added next to the device token', 'https://f4.example.org/w/?token=AbC', 'https://f4.example.org/w/?token=AbC&x=1'],
    ];
    const apart = cases.filter(([, a, b]) => !shareBudget(normalizeEndpoint(a)!, normalizeEndpoint(b)!)).map(([what]) => what);
    assert.deepEqual(apart, []);
  });

  // The endpoint shapes of the push services and distributors Bulwark's clients register.
  const device = (i: number) => `${'AbCdEfGh'.repeat(4)}${i}`;
  const shapes: Array<[string, (i: number) => string]> = [
    ['WNS (Edge)', (i) => `https://wns2-am3p.notify.windows.com/w/?token=BQYAAAD${device(i)}%2b${i}%2f%3d%3d`],
    ['the UnifiedPush FCM distributor', (i) => `https://fcm.distributor.unifiedpush.org/FCM?v2&instance=${i}-inst&token=${device(i)}:APA91b${device(i)}`],
    ['Gotify', (i) => `https://gotify.example.org/UP?token=${device(i)}`],
    ['FCM (Chrome)', (i) => `https://fcm.googleapis.com/fcm/send/${device(i)}:APA91b${device(i)}`],
    ['Mozilla (Firefox, Sunup)', (i) => `https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB${device(i)}`],
    ['Apple (Safari)', (i) => `https://web.push.apple.com/Q${device(i)}`],
    ['ntfy.sh', (i) => `https://ntfy.sh/up${device(i)}?up=1`],
    ['a self-hosted ntfy', (i) => `https://ntfy.example.org:8443/up${device(i)}?up=1`],
    ['NextPush', (i) => `https://cloud.example.org/index.php/apps/uppush/push/${device(i)}`],
    ['Conversations', (i) => `https://up.conversations.im/push/${device(i)}`],
  ];

  it('keeps a budget of its own for every device of every push service', () => {
    const shared = shapes.filter(([, shape]) => shareBudget(normalizeEndpoint(shape(1))!, normalizeEndpoint(shape(2))!)).map(([what]) => what);
    assert.deepEqual(shared, []);
  });

  it('shares one budget between one device\'s endpoint written with different extra query parameters', () => {
    const cases: Array<[string, string, string]> = [
      ['WNS, a parameter in front of the token', shapes[0][1](3), shapes[0][1](3).replace('?token=', '?x=1&token=')],
      ['WNS, the token\'s escapes in upper case', shapes[0][1](4), shapes[0][1](4).replace('%2b', '%2B').replace('%2f%3d%3d', '%2F%3D%3D')],
      ['the FCM distributor, another instance and one more parameter', shapes[1][1](5), `${shapes[1][1](5).replace('5-inst', 'other')}&y=2`],
      ['Gotify, a parameter added', shapes[2][1](6), `${shapes[2][1](6)}&x=1`],
      ['FCM (Chrome), a query added', shapes[3][1](7), `${shapes[3][1](7)}?x=1`],
      ['Mozilla, a query added', shapes[4][1](8), `${shapes[4][1](8)}?a=b`],
      ['ntfy.sh, another query', shapes[6][1](9), shapes[6][1](9).replace('?up=1', '?up=2')],
    ];
    const apart = cases.filter(([, a, b]) => !shareBudget(normalizeEndpoint(a)!, normalizeEndpoint(b)!)).map(([what]) => what);
    assert.deepEqual(apart, []);
    // A host the relay doesn't know and a query without `token`: that service may keep the device
    // in another parameter, so the query still counts.
    assert.equal(shareBudget('https://push.example.net/up/a?up=1', 'https://push.example.net/up/a?up=2'), false);
  });

  // On the hosts that keep the device in the path a parameter named `token` is one more extra
  // parameter. Where the token does count, its name is read decoded and in any case, as .NET,
  // which WNS runs on, reads query names.
  it('shares one budget between one device\'s endpoint and a parameter that looks like the device token', () => {
    const wns = (c: number) => `BQYAAAD${c}x${'x'.repeat(40)}%2babc%2f%3d%3d`;
    const fcm = (c: number) => `dXk3c2V0${c}ZG9tOmV4:APA91bH${'y'.repeat(120)}`;
    const cases: Array<[string, (c: number) => string, (c: number) => string]> = [
      ['FCM web with ?token added', (c) => `https://fcm.googleapis.com/fcm/send/${fcm(c)}`, (c) => `https://fcm.googleapis.com/fcm/send/${fcm(c)}?token=1`],
      ['FCM web with two different ?token values', (c) => `https://fcm.googleapis.com/fcm/send/${fcm(c)}?token=1`, (c) => `https://fcm.googleapis.com/fcm/send/${fcm(c)}?token=2`],
      ['Mozilla with ?token added', (c) => `https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB${c}d`, (c) => `https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB${c}d?token=1`],
      ['Apple with ?token added', (c) => `https://web.push.apple.com/Q${c}device`, (c) => `https://web.push.apple.com/Q${c}device?token=1`],
      ['ntfy.sh with &token added', (c) => `https://ntfy.sh/up${c}Topic?up=1`, (c) => `https://ntfy.sh/up${c}Topic?up=1&token=1`],
      ['WNS with the name escaped and one more parameter', (c) => `https://wns2-am3p.notify.windows.com/w/?token=${wns(c)}`, (c) => `https://wns2-am3p.notify.windows.com/w/?%74oken=${wns(c)}&x=1`],
      ['WNS with the name in capitals and one more parameter', (c) => `https://wns2-am3p.notify.windows.com/w/?token=${wns(c)}`, (c) => `https://wns2-am3p.notify.windows.com/w/?Token=${wns(c)}&x=1`],
    ];
    const apart = cases.map(([what, a, b], i) => [what, a(100 + i), b(100 + i)] as const)
      .filter(([, a, b]) => !shareBudget(normalizeEndpoint(a)!, normalizeEndpoint(b)!)).map(([what]) => what);
    assert.deepEqual(apart, []);
  });

  // `token` given twice: the first counts, as most servers that read the parameter by name take it.
  // Values added after it change nothing, and a different first value is a different device.
  it('counts the first of two token parameters, so they give neither one device two budgets nor two devices one', () => {
    const wns = (value: string) => `https://wns2-am3p.notify.windows.com/w/?token=${value}`;
    const same: Array<[string, string, string]> = [
      ['a second token after the first', wns('Twice1A'), `${wns('Twice1A')}&token=Twice1B`],
      ['two different second tokens', `${wns('Twice2A')}&token=Extra1`, `${wns('Twice2A')}&token=Extra2`],
      ['a second token written another way', wns('Twice3A'), `${wns('Twice3A')}&TOKEN=Twice3B&%74oken=Twice3C`],
    ];
    const apart: Array<[string, string, string]> = [
      ['the second value alone, another device', `${wns('Twice4A')}&token=Twice4B`, wns('Twice4B')],
      ['the same two values the other way round', `${wns('Twice5A')}&token=Twice5B`, `${wns('Twice5B')}&token=Twice5A`],
      ['two devices', wns('Twice6A'), wns('Twice6B')],
    ];
    assert.deepEqual(same.filter(([, a, b]) => !shareBudget(normalizeEndpoint(a)!, normalizeEndpoint(b)!)).map(([what]) => what), []);
    assert.deepEqual(apart.filter(([, a, b]) => shareBudget(normalizeEndpoint(a)!, normalizeEndpoint(b)!)).map(([what]) => what), []);
  });

  // A parameter whose name can't be decoded is no `token`: it doesn't hide the token after it, and
  // without a token the whole query counts, as on any host the relay doesn't know.
  it('reads past a parameter whose name cannot be decoded', () => {
    const base = 'https://wns2-am3p.notify.windows.com/w/';
    assert.equal(shareBudget(normalizeEndpoint(`${base}?token=Undecodable1`)!, normalizeEndpoint(`${base}?%E0%A4%A=x&token=Undecodable1`)!), true);
    assert.equal(shareBudget(normalizeEndpoint(`${base}?%E0%A4%A=x1`)!, normalizeEndpoint(`${base}?%E0%A4%A=x2`)!), false);
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
