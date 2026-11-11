// Runs the real relay as a child process next to a local HTTPS server that
// plays the push service, so route tests go through sockets, TLS, RFC 8291
// encryption and the store on disk. The certificate is a throwaway for
// localhost, trusted only through NODE_EXTRA_CA_CERTS in the child.
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
export const CERT_FILE = path.join(HERE, 'localhost.crt');
const KEY_FILE = path.join(HERE, 'localhost.key');

export interface PushRequest {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  at: number;
}

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  hang?: boolean;
  body?: string;
  delayMs?: number;
  /** Keep the answer's body coming, one byte at this interval. */
  dripMs?: number;
  /** Stream this many bytes of body. */
  floodBytes?: number;
}

export interface FakePushService {
  port: number;
  url(pathname: string): string;
  requests: PushRequest[];
  /** Requests to one path. */
  to(pathname: string): PushRequest[];
  /** How a path answers from now on. Unlisted paths answer 201. */
  answer(pathname: string, how: Answer): void;
  close(): Promise<void>;
}

/** How much of a floodBytes answer actually went out. */
export const floodSent = { bytes: 0 };

export async function startFakePushService(): Promise<FakePushService> {
  const answers = new Map<string, Answer>();
  const requests: PushRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = https.createServer(
    { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) },
    (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const pathname = req.url ?? '/';
        requests.push({ path: pathname, method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks), at: Date.now() });
        const how = answers.get(pathname) ?? {};
        if (how.hang) return;
        if (how.dripMs) {
          res.writeHead(how.status ?? 201);
          const timer = setInterval(() => res.write('x'), how.dripMs);
          res.on('close', () => clearInterval(timer));
          return;
        }
        if (how.floodBytes) {
          res.writeHead(how.status ?? 500);
          const chunk = Buffer.alloc(64 * 1024, 'x');
          let left = how.floodBytes;
          const pump = () => {
            while (left > 0) {
              left -= chunk.length;
              floodSent.bytes += chunk.length;
              if (!res.write(chunk)) {
                res.once('drain', pump);
                return;
              }
            }
            res.end();
          };
          res.on('close', () => { left = 0; });
          pump();
          return;
        }
        setTimeout(() => {
          res.writeHead(how.status ?? 201, how.headers ?? {});
          res.end(how.body ?? '');
        }, how.delayMs ?? 0);
      });
    },
  );
  server.on('secureConnection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    url: (pathname) => `https://localhost:${port}${pathname}`,
    requests,
    to: (pathname) => requests.filter((r) => r.path === pathname),
    answer: (pathname, how) => void answers.set(pathname, how),
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

export interface FakeDevice {
  keys: { p256dh: string; auth: string };
  /** RFC 8291 + RFC 8188 aes128gcm, single record, done by hand so the relay's library isn't checking itself. */
  decrypt(body: Buffer): string;
}

export function makeDevice(): FakeDevice {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const receiverPublic = ecdh.getPublicKey();
  return {
    keys: { p256dh: receiverPublic.toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const recordSize = body.readUInt32BE(16);
      const idLength = body.readUInt8(20);
      const senderPublic = body.subarray(21, 21 + idLength);
      const ciphertext = body.subarray(21 + idLength);
      if (ciphertext.length > recordSize) throw new Error('more than one record');
      const secret = ecdh.computeSecret(senderPublic);
      const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, senderPublic]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, info, 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
      // Padding: a 0x02 delimiter, then zeros.
      let end = plain.length - 1;
      while (end >= 0 && plain[end] === 0) end--;
      if (plain[end] !== 2) throw new Error('bad padding delimiter');
      return plain.subarray(0, end).toString('utf8');
    },
  };
}

export interface RunningRelay {
  base: string;
  port: number;
  dataDir: string;
  logs(): string;
  exited(): boolean;
  exitCode(): number | null;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
  /** Another relay process over the same data directory. */
  restart(): Promise<RunningRelay>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function startRelay(options: { env?: Record<string, string>; dataDir?: string; vapid?: boolean; skipHealthCheck?: boolean } = {}): Promise<RunningRelay> {
  const dataDir = options.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'relay-route-'));
  const port = await freePort();
  const vapid = options.vapid === false ? {} : testVapid();
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join('src', 'server.ts')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUSH_DATA_DIR: dataDir,
        NODE_EXTRA_CA_CERTS: CERT_FILE,
        // The fake push service lives on localhost.
        PUSH_ALLOW_PRIVATE_ENDPOINTS: 'localhost',
        // Metrics stay off unless a test turns them on.
        METRICS_TOKEN: '',
        METRICS_TOKEN_FILE: '',
        ...vapid,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  let exitCode: number | null = null;
  let hasExited = false;
  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      hasExited = true;
      exitCode = code;
      resolve(code);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (hasExited) throw new Error(`relay exited during start: ${output}`);
    try {
      // The route that touches the store could hide what a first request sees.
      const res = await fetch(options.skipHealthCheck ? `${base}/nothing` : `${base}/api/health`);
      if (res.ok || options.skipHealthCheck) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`relay did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const relay: RunningRelay = {
    base,
    port,
    dataDir,
    logs: () => output,
    exited: () => hasExited,
    exitCode: () => exitCode,
    stop: async (signal = 'SIGTERM') => {
      if (!hasExited) child.kill(signal);
      return exit;
    },
    restart: async () => {
      await relay.stop();
      return startRelay({ ...options, dataDir });
    },
  };
  return relay;
}

let vapidKeys: { VAPID_PUBLIC_KEY: string; VAPID_PRIVATE_KEY: string; VAPID_SUBJECT: string } | null = null;

export function testVapid() {
  if (!vapidKeys) {
    const keys = webpush.generateVAPIDKeys();
    vapidKeys = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:test@example.org' };
  }
  return vapidKeys;
}

export function newId(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Where the store keeps its files. Tests go through the helpers below instead.
const SNAPSHOT = 'subscriptions.json';
const JOURNAL = 'subscriptions.journal';

/** The records a relay keeps in this data directory, as it would load them: the snapshot, then the journal. */
export function storedRecords(dataDir: string): Record<string, any> {
  const records: Record<string, any> = {};
  for (const name of [SNAPSHOT, `${SNAPSHOT}.bak`]) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    Object.assign(records, JSON.parse(fs.readFileSync(file, 'utf8')).records);
    break;
  }
  const journal = path.join(dataDir, JOURNAL);
  const lines = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8').split('\n') : [];
  for (const line of lines) {
    if (!line) continue;
    let entry: { id: string; record: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.record === null) delete records[entry.id];
    else records[entry.id] = entry.record;
  }
  return records;
}

/**
 * Writes a store in the format of the relay before the journal: one
 * subscriptions.json, which every relay since reads. Records as an object, or
 * the file's text as is. Returns the data directory, a new one unless given.
 */
export function seedStore(records: Record<string, unknown> | string, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-seed-'))): string {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SNAPSHOT), typeof records === 'string' ? records : JSON.stringify({ records }));
  return dataDir;
}

/**
 * From now on no write of the relay's store reaches the disk: a directory sits
 * where each of its files would be written. What it wrote since its last
 * snapshot is gone from the disk.
 */
export function blockStoreWrites(dataDir: string): void {
  for (const name of [JOURNAL, `${SNAPSHOT}.tmp`]) {
    const file = path.join(dataDir, name);
    fs.rmSync(file, { force: true });
    fs.mkdirSync(file, { recursive: true });
  }
}

export async function postJson(base: string, pathname: string, body: unknown): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function getJson(base: string, pathname: string, method = 'GET'): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(base + pathname, { method });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** What Stalwart posts for a verification. */
export function pushVerification(code: string) {
  return { '@type': 'PushVerification', pushSubscriptionId: 'b', verificationCode: code };
}

/** What Stalwart posts for new mail without a filter. */
export function stateChange(changed: Record<string, Record<string, string>>) {
  return { '@type': 'StateChange', changed };
}

/** What Stalwart posts for new mail that passed a filter. */
export function emailPush(accountId: string, ids: string[], state = 'sa') {
  return { '@type': 'EmailPush', accountId, emails: ids.map((id) => ({ id, threadId: `t${id}` })), state };
}

/** Sends one raw request over a plain socket; for what fetch refuses to send. */
export function rawRequest(port: number, text: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
    let out = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { out += chunk; });
    const done = () => resolve(out);
    socket.on('close', done);
    socket.on('error', done);
    socket.setTimeout(timeoutMs, () => socket.destroy());
  });
}

export interface FakeApns {
  origin: string;
  /** Connections accepted so far. */
  sessionCount(): number;
  requests: { path: string; headers: http2.IncomingHttpHeaders; body: string }[];
  answer(status: number, body?: string): void;
  hang(on: boolean): void;
  close(): Promise<void>;
}

export async function startFakeApns(): Promise<FakeApns> {
  const requests: FakeApns['requests'] = [];
  let status = 200;
  let text = '';
  let hanging = false;
  const server = http2.createSecureServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) });
  const sessions = new Set<http2.ServerHttp2Session>();
  let sessionCount = 0;
  server.on('session', (session) => {
    sessionCount += 1;
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => { body += chunk; });
    stream.on('end', () => {
      requests.push({ path: String(headers[':path']), headers, body });
      if (hanging) return;
      stream.respond({ ':status': status });
      stream.end(text);
    });
    stream.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    origin: `https://localhost:${port}`,
    sessionCount: () => sessionCount,
    requests,
    answer: (nextStatus, nextBody = '') => { status = nextStatus; text = nextBody; },
    hang: (on) => { hanging = on; },
    close: () => new Promise((resolve) => {
      for (const session of sessions) session.destroy();
      server.close(() => resolve());
    }),
  };
}

export function apnsKeyPem(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function serviceAccount(projectId: string, tokenUri: string) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: `${projectId}-key`,
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: `relay@${projectId}.iam.gserviceaccount.com`,
    token_uri: tokenUri,
  };
}
