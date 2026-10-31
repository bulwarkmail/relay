import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { isSenderMismatch, resetFcmState, sendFcmPush } from './fcm.js';
import type { FcmSubscriptionRecord, ForwardPayload } from './types.js';

const payload = {
  kind: 'state',
  accountLabel: 'a',
  accountId: 'a',
  emailIds: [],
  changed: {},
} as unknown as ForwardPayload;

function record(token: string): FcmSubscriptionRecord {
  return { kind: 'fcm', fcmToken: token } as unknown as FcmSubscriptionRecord;
}

function account(projectId: string) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: `${projectId}-key`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `relay@${projectId}.iam.gserviceaccount.com`,
    token_uri: 'https://oauth.test/token',
  };
}

// Each fake project accepts only its own tokens ("<project>:<id>"), like FCM.
const sends: string[] = [];
const realFetch = globalThis.fetch;
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fcm-'));
  fs.writeFileSync(path.join(dir, 'fcm-service-account.json'), JSON.stringify(account('new-project')));
  fs.writeFileSync(path.join(dir, 'fcm-service-account-old.json'), JSON.stringify(account('old-project')));
  process.env.PUSH_DATA_DIR = dir;
  delete process.env.FCM_SERVICE_ACCOUNT_JSON;
  resetFcmState();
  sends.length = 0;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth.test/token') {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    }
    const project = decodeURIComponent(url.match(/projects\/([^/]+)\/messages:send/)![1]);
    const token = JSON.parse(String(init!.body)).message.token as string;
    sends.push(project);
    if (token.startsWith(`${project}:`)) {
      return new Response(JSON.stringify({ name: 'm' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'SenderId mismatch' } }),
      { status: 403 },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sendFcmPush across Firebase projects', () => {
  it('sends a new-project token through the main account only', async () => {
    const result = await sendFcmPush(record('new-project:1'), payload);
    assert.equal(result.ok, true);
    assert.deepEqual(sends, ['new-project']);
  });

  it('falls back to the old project on a sender mismatch, then goes there first', async () => {
    const first = await sendFcmPush(record('old-project:1'), payload);
    assert.equal(first.ok, true);
    assert.deepEqual(sends, ['new-project', 'old-project']);

    sends.length = 0;
    const second = await sendFcmPush(record('old-project:1'), payload);
    assert.equal(second.ok, true);
    assert.deepEqual(sends, ['old-project']);
  });

  it('reports the failure when no project takes the token', async () => {
    const result = await sendFcmPush(record('third-project:1'), payload);
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.deepEqual(sends, ['new-project', 'old-project']);
  });
});

describe('isSenderMismatch', () => {
  it('matches FCM\'s answers for a token of another project', () => {
    assert.equal(isSenderMismatch(403, 'PERMISSION_DENIED', 'SenderId mismatch'), true);
    assert.equal(isSenderMismatch(403, 'SENDER_ID_MISMATCH', ''), true);
    assert.equal(isSenderMismatch(403, 'PERMISSION_DENIED', 'The caller does not have permission'), false);
    assert.equal(isSenderMismatch(404, 'NOT_FOUND', 'SenderId mismatch'), false);
  });
});
