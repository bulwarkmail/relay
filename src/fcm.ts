import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { failureReason, type SendResult } from './forward-result.js';
import type { FcmSubscriptionRecord, ForwardPayload } from './types.js';

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

/**
 * One Firebase project the relay can send through. A token only works with
 * the project of the app that issued it, so the relay keeps a project per
 * app generation: the main service account (FCM_SERVICE_ACCOUNT_JSON or
 * fcm-service-account.json) and any fcm-service-account-<name>.json next to
 * it, e.g. the old project while installed apps still hold its tokens.
 */
interface FcmProject {
  account: ServiceAccount;
  accessToken: { token: string; expiresAt: number } | null;
}

let cachedProjects: FcmProject[] | null = null;

/** The project that last accepted each token, so it is tried first. */
const projectForToken = new Map<string, string>();

async function readAccount(filePath: string): Promise<ServiceAccount> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as ServiceAccount;
}

async function loadProjects(): Promise<FcmProject[]> {
  if (cachedProjects) return cachedProjects;
  const dir = process.env.PUSH_DATA_DIR ?? './data';

  const inline = process.env.FCM_SERVICE_ACCOUNT_JSON;
  let main: ServiceAccount;
  if (inline && inline.trim().startsWith('{')) {
    main = JSON.parse(inline) as ServiceAccount;
  } else {
    main = await readAccount(
      inline && inline.trim().length > 0 ? inline : path.join(dir, 'fcm-service-account.json'),
    );
  }

  const extraFiles = (await fs.readdir(dir).catch(() => [] as string[]))
    .filter((f) => /^fcm-service-account-.+\.json$/.test(f))
    .sort();
  const accounts = [main];
  for (const f of extraFiles) {
    const account = await readAccount(path.join(dir, f));
    if (!accounts.some((a) => a.project_id === account.project_id)) accounts.push(account);
  }
  cachedProjects = accounts.map((account) => ({ account, accessToken: null }));
  return cachedProjects;
}

/** Test hook: forget loaded accounts, tokens and which project took which token. */
export function resetFcmState(): void {
  cachedProjects = null;
  projectForToken.clear();
}

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintAccessToken(project: FcmProject): Promise<string> {
  const now = Date.now();
  if (project.accessToken && project.accessToken.expiresAt - 60_000 > now) {
    return project.accessToken.token;
  }

  const { account } = project;
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header = { alg: 'RS256', typ: 'JWT', kid: account.private_key_id };
  const claim = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: account.token_uri ?? 'https://oauth2.googleapis.com/token',
    iat,
    exp,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signature = crypto
    .createSign('RSA-SHA256')
    .update(signingInput)
    .sign(account.private_key);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(account.token_uri ?? 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`FCM oauth2 token failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  project.accessToken = {
    token: body.access_token,
    expiresAt: now + body.expires_in * 1000,
  };
  return body.access_token;
}

/**
 * FCM's answer to a token from another Firebase project: 403 with
 * PERMISSION_DENIED "SenderId mismatch" (SENDER_ID_MISMATCH in the details).
 */
export function isSenderMismatch(status: number, errStatus: string, message: string): boolean {
  return status === 403 && (errStatus === 'SENDER_ID_MISMATCH' || /sender ?id mismatch/i.test(message));
}

export interface FcmSendResult extends SendResult {
  body?: unknown;
}

export async function sendFcmPush(
  record: FcmSubscriptionRecord,
  payload: ForwardPayload,
): Promise<FcmSendResult> {
  const projects = await loadProjects();
  const known = projectForToken.get(record.fcmToken);
  const ordered = [
    ...projects.filter((p) => p.account.project_id === known),
    ...projects.filter((p) => p.account.project_id !== known),
  ];
  let result: FcmSendResult & { senderMismatch?: boolean; projectId?: string } = {
    ok: false,
    status: 0,
    unregistered: false,
  };
  for (const project of ordered) {
    result = await sendWithProject(project, record, payload);
    if (!result.senderMismatch) break;
  }
  if (result.ok && result.projectId) projectForToken.set(record.fcmToken, result.projectId);
  if (result.unregistered) projectForToken.delete(record.fcmToken);
  const { senderMismatch: _mismatch, projectId: _project, ...rest } = result;
  return rest;
}

async function sendWithProject(
  project: FcmProject,
  record: FcmSubscriptionRecord,
  payload: ForwardPayload,
): Promise<FcmSendResult & { senderMismatch: boolean; projectId: string }> {
  const { account } = project;
  const accessToken = await mintAccessToken(project);
  // Data-only push so onMessageReceived always fires — the app enriches it
  // (sender/subject/avatar) via JMAP fetch before posting a notification.
  // FCM data values must be strings, hence the JSON-encoded fields.
  const message = {
    message: {
      token: record.fcmToken,
      android: {
        priority: 'HIGH',
      },
      data: {
        kind: payload.kind,
        accountLabel: payload.accountLabel,
        accountId: payload.accountId,
        emailIds: JSON.stringify(payload.emailIds),
        changed: JSON.stringify(payload.changed),
      },
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(message),
    },
  );

  const rawBody = await res.text();
  let parsed: unknown = rawBody;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    // keep raw text
  }

  const fcmError =
    typeof parsed === 'object' && parsed && 'error' in parsed
      ? (parsed as { error?: { status?: string; message?: string } }).error
      : undefined;
  const errStatus = fcmError?.status ?? '';
  const unregistered =
    res.status === 404 || errStatus === 'UNREGISTERED' || errStatus === 'NOT_FOUND';

  return {
    ok: res.ok,
    status: res.status,
    unregistered,
    senderMismatch: isSenderMismatch(res.status, errStatus, fcmError?.message ?? ''),
    projectId: account.project_id,
    reason: res.ok
      ? undefined
      : failureReason(fcmError ? `${errStatus}: ${fcmError.message ?? ''}` : rawBody),
    body: parsed,
  };
}
