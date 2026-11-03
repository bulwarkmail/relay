import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPublicAddress, isPublicEndpointUrl } from './endpoint-guard.js';
import {
  isValidUnifiedPushEndpoint,
  isValidUnifiedPushKeys,
} from './validation.js';

describe('isPublicEndpointHost', () => {
  it('refuses what only reaches the relay itself or its network', () => {
    for (const url of [
      'https://localhost/x',
      'https://LOCALHOST./x',
      'https://foo.localhost/x',
      'https://relay-test/x',
      'https://postgres:5432/x',
      'https://printer.local/x',
      'https://service.internal/x',
      'https://127.0.0.1/x',
      'https://127.1/x',
      'https://2130706433/x',
      'https://0x7f.0.0.1/x',
      'https://0.0.0.0/x',
      'https://10.1.2.3/x',
      'https://172.16.0.1/x',
      'https://192.168.178.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://[::]/x',
      'https://[::ffff:127.0.0.1]/x',
      'https://[::ffff:a9fe:a9fe]/x',
      'https://[fd00::1]/x',
      'https://[fe80::1]/x',
      'https://[fec0::1]/x',
      'https://[64:ff9b::7f00:1]/x',
      'https://user:password@push.example.org/x',
      'http://push.example.org/x',
      'not a url at all',
    ]) {
      assert.equal(isPublicEndpointUrl(url), false, url);
    }
  });

  it('accepts the push services and public hosts', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QOabc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://ntfy.sh/upabc?up=1',
      'https://push.murena.com/abc',
      'https://8.8.8.8/x',
      'https://[2606:4700:4700::1111]/x',
    ]) {
      assert.equal(isPublicEndpointUrl(url), true, url);
    }
  });

  it('lets an operator name private hosts', () => {
    process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS = 'ntfy.lan, 10.0.0.5';
    try {
      assert.equal(isPublicEndpointUrl('https://ntfy.lan/x'), true);
      assert.equal(isPublicEndpointUrl('https://10.0.0.5/x'), true);
      assert.equal(isPublicEndpointUrl('https://10.0.0.6/x'), false);
    } finally {
      delete process.env.PUSH_ALLOW_PRIVATE_ENDPOINTS;
    }
  });

  it('refuses a private address from DNS, unless the host is named', () => {
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:10.0.0.1', 'fd12::1', 'garbage']) {
      assert.equal(isPublicAddress(address), false, address);
    }
  });
});

describe('isValidUnifiedPushEndpoint', () => {
  it('accepts an https distributor endpoint', () => {
    assert.equal(isValidUnifiedPushEndpoint('https://ntfy.sh/upA1b2C3d4?up=1'), true);
  });

  it('rejects plain http, other schemes, and junk', () => {
    assert.equal(isValidUnifiedPushEndpoint('http://ntfy.sh/upA1b2C3d4'), false);
    assert.equal(isValidUnifiedPushEndpoint('ftp://example.com/x'), false);
    assert.equal(isValidUnifiedPushEndpoint(''), false);
    assert.equal(isValidUnifiedPushEndpoint(null), false);
    assert.equal(isValidUnifiedPushEndpoint(42), false);
  });

  it('rejects oversized endpoints', () => {
    assert.equal(isValidUnifiedPushEndpoint('https://x.example/' + 'a'.repeat(2048)), false);
  });
});

describe('isValidUnifiedPushKeys', () => {
  const p256dh = 'B'.repeat(87); // typical uncompressed P-256 point, base64url
  const auth = 'a'.repeat(22); // typical 16-byte auth secret, base64url

  it('accepts a plausible key set', () => {
    assert.equal(isValidUnifiedPushKeys({ p256dh, auth }), true);
  });

  it('rejects missing or truncated keys', () => {
    assert.equal(isValidUnifiedPushKeys(null), false);
    assert.equal(isValidUnifiedPushKeys({}), false);
    assert.equal(isValidUnifiedPushKeys({ p256dh, auth: 'short' }), false);
    assert.equal(isValidUnifiedPushKeys({ p256dh: 'short', auth }), false);
  });
});
