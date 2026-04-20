import http from 'node:http';
import { URL } from 'node:url';
import { logger } from './logger.js';
import { subscriptionStore } from './store.js';
import { sendFcmPush } from './fcm.js';
import { isValidFcmToken, isValidSubscriptionId } from './validation.js';
import type { JmapPushBody, SubscriptionRecord } from './types.js';

const PORT = Number(process.env.PORT ?? 3003);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY_BYTES = 64 * 1024;
const REPO_URL = 'https://github.com/bulwarkmail/relay';

const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Bulwark Push Relay</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 system-ui, -apple-system, Segoe UI, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Bulwark Push Relay</h1>
<p>When your mail server has something new, this pings your phone. That's the whole job.</p>
<p>It doesn't see the mail. Not the subject, not the sender, not a byte of the body. Just a ping and a push token.</p>
<p>Source: <a href="${REPO_URL}">${REPO_URL}</a></p>
</body>
</html>
`;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function handleRegister(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = (await readJson(req)) as
    | { subscriptionId?: unknown; fcmToken?: unknown; accountLabel?: unknown }
    | null
    | undefined;
  if (!body || typeof body !== 'object') {
    return sendJson(res, 400, { error: 'Invalid JSON' });
  }
  const { subscriptionId, fcmToken, accountLabel } = body;
  if (!isValidSubscriptionId(subscriptionId)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  if (!isValidFcmToken(fcmToken)) {
    return sendJson(res, 400, { error: 'Invalid fcmToken' });
  }

  const existing = await subscriptionStore.get(subscriptionId);
  const record: SubscriptionRecord = {
    fcmToken,
    verificationCode: existing?.verificationCode ?? null,
    createdAt: existing?.createdAt ?? Date.now(),
    lastPushAt: existing?.lastPushAt ?? null,
    accountLabel:
      typeof accountLabel === 'string' ? accountLabel.slice(0, 120) : undefined,
  };
  await subscriptionStore.put(subscriptionId, record);
  return sendJson(res, 200, { ok: true });
}

async function handleUnregister(
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  await subscriptionStore.delete(id);
  return sendJson(res, 200, { ok: true });
}

async function handleVerifyPoll(
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }
  const record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }
  return sendJson(res, 200, { verificationCode: record.verificationCode ?? null });
}

async function handleJmap(
  req: http.IncomingMessage,
  id: string,
  res: http.ServerResponse,
): Promise<void> {
  if (!isValidSubscriptionId(id)) {
    return sendJson(res, 400, { error: 'Invalid subscriptionId' });
  }

  const record = await subscriptionStore.get(id);
  if (!record) {
    return sendJson(res, 404, { error: 'Unknown subscription' });
  }

  const body = (await readJson(req)) as JmapPushBody | null | undefined;
  if (!body || typeof body !== 'object' || typeof body['@type'] !== 'string') {
    return sendJson(res, 400, { error: 'Invalid JMAP push body' });
  }

  if (body['@type'] === 'PushVerification') {
    record.verificationCode = body.verificationCode;
    await subscriptionStore.put(id, record);
    return sendJson(res, 200, { ok: true });
  }

  if (body['@type'] === 'StateChange') {
    const result = await sendFcmPush(record, body);
    record.lastPushAt = Date.now();
    await subscriptionStore.put(id, record);
    if (result.unregistered) {
      await subscriptionStore.delete(id);
    }
    return sendJson(res, 200, { ok: result.ok });
  }

  return sendJson(res, 400, { error: 'Unsupported JMAP push type' });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  try {
    if (method === 'GET' && path === '/api/health') {
      const count = await subscriptionStore.size();
      return sendJson(res, 200, { ok: true, subscriptions: count });
    }

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const accept = req.headers.accept ?? '';
      if (accept.includes('application/json') && !accept.includes('text/html')) {
        return sendJson(res, 200, {
          service: 'bulwark-push-relay',
          repo: REPO_URL,
          health: '/api/health',
        });
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(LANDING_HTML),
        'cache-control': 'public, max-age=300',
      });
      res.end(LANDING_HTML);
      return;
    }

    if (method === 'POST' && path === '/api/push/register') {
      return await handleRegister(req, res);
    }

    const registerIdMatch = path.match(/^\/api\/push\/register\/([^/]+)$/);
    if (method === 'DELETE' && registerIdMatch) {
      return await handleUnregister(decodeURIComponent(registerIdMatch[1]), res);
    }

    const verifyMatch = path.match(/^\/api\/push\/verify\/([^/]+)$/);
    if (method === 'GET' && verifyMatch) {
      return await handleVerifyPoll(decodeURIComponent(verifyMatch[1]), res);
    }

    const jmapMatch = path.match(/^\/api\/push\/jmap\/([^/]+)$/);
    if (method === 'POST' && jmapMatch) {
      return await handleJmap(req, decodeURIComponent(jmapMatch[1]), res);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    if (msg === 'Payload too large') {
      return sendJson(res, 413, { error: msg });
    }
    logger.error('relay: handler failed', { method, path, error: msg });
    if (!res.headersSent) {
      return sendJson(res, 500, { error: 'Internal server error' });
    }
    res.end();
  } finally {
    logger.info('relay: request', {
      method,
      path,
      status: res.statusCode,
      ms: Date.now() - started,
    });
  }
});

server.listen(PORT, HOST, () => {
  logger.info('relay: listening', { host: HOST, port: PORT });
});

const shutdown = (signal: string) => {
  logger.info('relay: shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
