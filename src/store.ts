import { createReadStream } from 'node:fs';
import { readFile, open, mkdir, rename, unlink, chmod, readdir, stat, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import { storeWriteFailures } from './metrics.js';
import type { SubscriptionRecord } from './types.js';
import { sameSecretHash } from './validation.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Aligned with the JMAP PushSubscription expires the mobile client requests
// (90 days). A push or a registration refreshes the record, so this only
// matters for devices that have gone away for good.
const TTL_MS = 90 * DAY_MS;
// A record that never delivered a push and whose code no client ever picked up
// has never worked. A real device registers again on every page load and app
// start, so it is back long before this.
const UNUSED_TTL_MS = 7 * DAY_MS;
// Expired records leave memory and the disk this often, not only at a start.
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// When the store is full a new device takes the place of a record that never
// delivered a push: first of one whose verification code no client collected,
// then of one whose code was collected, the one registered longest ago first in
// each; then of the record whose last push is the oldest. Never of one
// registered in the last 10 minutes, which may be a device in the middle of its
// setup, and of no record with a collected code while one without is in those
// minutes; never of one that delivered a push in the last 30 days.
const SETUP_GRACE_MS = 10 * 60 * 1000;
const RECENTLY_WORKED_MS = 30 * DAY_MS;

// The journal is folded into a new snapshot once it is larger than the snapshot,
// and not before it holds this much: a change costs one append, and the snapshot
// is written once per as many bytes of changes as it holds itself.
const MIN_FOLD_BYTES = 1024 * 1024;
// After a snapshot that could not be written, the next try waits this long, so
// a full disk doesn't cost a snapshot's worth of writing on every change.
const FOLD_RETRY_MS = 60 * 1000;
// Records per write while a snapshot goes to disk, so no string holds the whole store.
const SNAPSHOT_BATCH = 500;
// The most one record may take, as JSON. A registration with every field at its
// limit takes under 3 KB (an endpoint of 2,048 characters is most of it), and a
// verification code at its limit up to 1 KB more. Real ones take a few hundred
// bytes. With the record limit this bounds the store: see the README, "Limits".
export const MAX_RECORD_BYTES = 4096;
// What a registration may take, so that a verification code still fits.
export const MAX_REGISTRATION_BYTES = 3072;

// The store holds every device's endpoint, keys and token: the relay's own user
// alone may read it. File modes mean nothing on Windows.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const POSIX = process.platform !== 'win32';

function getPushDir(): string {
  return process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data');
}

// {"seq":<last change it holds>,"records":{...}}, one record per line, so that
// a start reads it a line at a time. An older relay reads the records and ignores
// the number; one it writes has none, which counts as 0, and is read whole.
function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

function previousVersionPath(): string {
  return `${subscriptionsPath()}.bak`;
}

// The changes since a snapshot: a first line {"from":<the snapshot's seq>}, then
// one line per change, {"seq":n,"id":..,"record":{..}}, or "record":null for a
// delete, numbered on from there. A journal only ever continues a snapshot with a
// number, which an older relay's rewrite drops. Each line starts with its newline,
// so an append cut short by a crash stays a line of its own, which the next load skips.
function journalPath(): string {
  return path.join(getPushDir(), 'subscriptions.journal');
}

// Which relay process holds the data directory: written at its start, removed
// when it stops cleanly. Two relays on one directory would each write changes
// the other doesn't know about.
function lockPath(): string {
  return path.join(getPushDir(), 'subscriptions.lock');
}

/** Who wrote a lock: enough to tell on this machine whether that process still runs. */
export interface LockHolder {
  pid: number;
  host: string;
  // Linux only: the boot the process ran in, and its start time in that boot, so
  // that a process number given to another process since doesn't count.
  boot?: string;
  start?: string;
  startedAt: number;
}

async function bootId(): Promise<string | undefined> {
  return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')).trim() || undefined;
}

async function startTimeOf(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  // After the command name, which may hold spaces: field 22 is the 20th.
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] : undefined;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // It runs, as another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function currentLockHolder(): Promise<LockHolder> {
  return { pid: process.pid, host: os.hostname(), boot: await bootId(), start: await startTimeOf(process.pid), startedAt: Date.now() };
}

/**
 * Whether the relay that wrote a lock may still run, as far as `me` can tell.
 * Its process number only means something on the same host: a lock from another
 * host (another container without a fixed host name, another machine on a shared
 * mount) counts as held. On the same host it is free when the machine has
 * restarted since, when the number is this process's own (an earlier run in a
 * new container, where the relay gets the same number every time), when no
 * process has the number, or when the process that has it started at another
 * time (the number went to another process).
 */
export async function lockHolderRuns(holder: LockHolder, me: LockHolder): Promise<boolean> {
  if (holder.host !== me.host) return true;
  if (holder.boot && me.boot && holder.boot !== me.boot) return false;
  if (holder.pid === me.pid) return false;
  if (!isRunning(holder.pid)) return false;
  if (holder.start) {
    const start = await startTimeOf(holder.pid);
    if (start !== undefined && start !== holder.start) return false;
  }
  return true;
}

function parseLock(text: string): LockHolder | null {
  try {
    const value = JSON.parse(text) as Partial<LockHolder>;
    if (!value || !Number.isSafeInteger(value.pid) || typeof value.host !== 'string') return null;
    return value as LockHolder;
  } catch {
    return null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

const isSeq = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Bytes of a record as the store writes it. */
export function recordBytes(record: SubscriptionRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

const isReadError = (error: unknown) => typeof (error as NodeJS.ErrnoException | null)?.code === 'string';

/** The lines of a file, one at a time. A file that can't be read throws; a missing one says null. */
async function fileLines(file: string): Promise<{ lines: AsyncIterable<string>; size: number; close(): void } | null> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error(`${path.basename(file)} is not a file`), { code: 'EISDIR' });
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const input = createReadStream(file, 'utf-8');
  const lines = createInterface({ input, crlfDelay: Infinity });
  return { lines, size, close: () => { lines.close(); input.destroy(); } };
}

// After a rename or a new file the directory itself goes to disk too, or a power
// cut could lose the file. Windows can't sync a directory; nothing to do there.
async function syncDirectory(): Promise<void> {
  if (!POSIX) return;
  const handle = await open(getPushDir(), 'r').catch(() => null);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close().catch(() => undefined);
}

interface SubscriptionsFile {
  seq?: unknown;
  records: Record<string, SubscriptionRecord>;
}

interface Snapshot {
  records: Record<string, SubscriptionRecord>;
  // The last change it holds; null for one an older relay wrote.
  seq: number | null;
}

export type PutResult =
  | { stored: true; evicted?: { id: string; record: SubscriptionRecord } }
  | { stored: false; reason: 'full' | 'address-full' | 'not-owner' | 'taken' };

/**
 * Whether a caller who holds the secret with this hash (null: none) may act on
 * the record. Always on a record without a secret, as before secrets existed.
 */
export function mayUse(record: SubscriptionRecord, secretHash: string | null): boolean {
  return record.secretHash === undefined || (secretHash !== null && sameSecretHash(record.secretHash, secretHash));
}

const registeredAt = (record: SubscriptionRecord) => Math.max(record.createdAt, record.lastRegisteredAt ?? 0);

class SubscriptionStore {
  private records = new Map<string, SubscriptionRecord>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  // One write at a time, in the order the changes came in.
  private queue: Promise<unknown> = Promise.resolve();
  private snapshotBytes = 0;
  private journalBytes = 0;
  // The number of the last change made. Every change up to it is on disk, in
  // the snapshot or in the journal.
  private seq = 0;
  // What the snapshot on disk holds, up to which change, and whether it says
  // so: one an older relay wrote has no number, nor does a missing snapshot.
  private snapshotSeq = 0;
  private snapshotNumbered = false;
  private foldRetryAt = 0;
  private closed = false;
  // What this process wrote into subscriptions.lock, while it holds it.
  private lock: string | null = null;
  // The client address each record was last registered from, while the relay
  // runs. Never written to disk: after a start a record has none until its
  // client registers again, which it does on every page load and app start.
  private origins = new Map<string, string>();
  // Records per client address, from `origins`.
  private perAddress = new Map<string, number>();
  // Who gives way first when the store is full. Records that never delivered a
  // push, without a collected verification code and with one, each in the order
  // they were last registered (or had their code collected), and records that
  // did deliver, in the order of their last push. Maps keep the order they were
  // set in.
  private unconfirmed = new Map<string, true>();
  private confirmed = new Map<string, true>();
  private delivered = new Map<string, true>();

  /** Once, whoever asks. Rejects when a store exists that can't be read: see readSnapshot. */
  load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    await this.makePrivate();
    await this.takeLock();
    try {
      await this.readStore();
    } catch (error) {
      await this.releaseLock();
      throw error;
    }
  }

  /**
   * Takes subscriptions.lock for this process before anything is read. Rejects,
   * so the relay doesn't start, while another relay that may still run holds it
   * (see lockHolderRuns); one left by a relay that is gone is taken over.
   */
  private async takeLock(): Promise<void> {
    const file = lockPath();
    const text = JSON.stringify(await currentLockHolder());
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await open(file, 'wx', PRIVATE_FILE);
        try {
          await handle.writeFile(text, 'utf-8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.lock = text;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          logger.error('store: could not write subscriptions.lock', { error: message(error) });
          throw error;
        }
      }
      const found = await readFile(file, 'utf-8').catch(() => null);
      if (found === null) continue;
      const holder = parseLock(found);
      if (holder && (await lockHolderRuns(holder, JSON.parse(text) as LockHolder))) {
        logger.error('store: another relay holds this data directory, so this one does not start; stop that relay first, or remove subscriptions.lock if it no longer runs', {
          pid: holder.pid,
          host: holder.host,
          since: Number.isFinite(holder.startedAt) ? new Date(holder.startedAt).toISOString() : undefined,
        });
        throw new Error('the data directory is held by another relay');
      }
      // Only the lock judged here goes, not one a relay starting at the same time wrote since.
      if ((await readFile(file, 'utf-8').catch(() => null)) !== found) continue;
      await unlink(file).catch(() => undefined);
      logger.warn('store: took over subscriptions.lock from a relay that no longer runs', holder ? { pid: holder.pid, host: holder.host } : {});
    }
    logger.error('store: could not take subscriptions.lock; another relay keeps writing it');
    throw new Error('could not take subscriptions.lock');
  }

  // Removes subscriptions.lock, if it is still the one this process wrote.
  private async releaseLock(): Promise<void> {
    if (this.lock === null) return;
    const file = lockPath();
    if ((await readFile(file, 'utf-8').catch(() => null)) === this.lock) await unlink(file).catch(() => undefined);
    this.lock = null;
  }

  private async readStore(): Promise<void> {
    const snapshot =
      (await this.readSnapshot(subscriptionsPath())) ?? (await this.readSnapshot(previousVersionPath()));
    for (const [id, record] of Object.entries(snapshot?.records ?? {})) {
      if (id !== '__proto__') this.records.set(id, record);
    }
    this.seq = this.snapshotSeq = snapshot?.seq ?? 0;
    this.snapshotNumbered = snapshot != null && snapshot.seq !== null;
    const journal = await this.readJournal();
    this.migrateLegacyRecords();
    this.evictExpired();
    const byAge = [...this.records].sort(([, a], [, b]) =>
      (a.lastPushAt ?? registeredAt(a)) - (b.lastPushAt ?? registeredAt(b)));
    for (const [id, record] of byAge) this.order(id, record, true);
    this.loaded = true;
    // Starts the next journal from what is on disk now. Should that fail, the
    // journal stays, and the next start reads it again.
    if (journal) await this.serial(() => this.fold()).catch(() => undefined);
    setInterval(() => void this.sweep().catch(() => undefined), SWEEP_INTERVAL_MS).unref();
  }

  // Null when the file is missing or unusable. An unusable file is moved aside,
  // not left for the next write to replace: it may be every device's only
  // record, and one register call would otherwise wipe it. Unreadable, not
  // missing (permissions, a bad mount): starting empty would replace every
  // device's record with the next write, so this stops the start.
  private async readSnapshot(file: string): Promise<Snapshot | null> {
    try {
      const snapshot = (await this.readSnapshotLines(file)) ?? (await this.readSnapshotWhole(file));
      if (snapshot) this.snapshotBytes = (await stat(file)).size;
      return snapshot;
    } catch (error) {
      if (isReadError(error)) {
        logger.error('store: failed to read subscriptions', { file: path.basename(file), error: message(error) });
        throw error;
      }
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      if (POSIX) await chmod(aside, PRIVATE_FILE).catch(() => undefined);
      logger.error('store: subscriptions file is corrupt, moved aside', {
        file: path.basename(file),
        aside: path.basename(aside),
        error: message(error),
      });
      return null;
    }
  }

  // A snapshot this relay wrote, a line at a time, so that loading needs no
  // more memory than the records themselves. Null for a file in another form
  // (an older relay's), which readSnapshotWhole reads.
  private async readSnapshotLines(file: string): Promise<Snapshot | null | undefined> {
    const reader = await fileLines(file);
    if (!reader) return undefined;
    const records: Record<string, SubscriptionRecord> = Object.create(null);
    let seq: number | null = null;
    let ended = false;
    try {
      for await (const line of reader.lines) {
        if (seq === null) {
          const head = /^\{"seq":(\d+),"records":\{$/.exec(line);
          if (!head) return null;
          seq = Number(head[1]);
        } else if (ended) {
          if (line) throw new SyntaxError('text after the end of the records');
        } else if (line === '}}') {
          ended = true;
        } else {
          const entry = JSON.parse(`{${line.startsWith(',') ? line.slice(1) : line}}`) as Record<string, SubscriptionRecord>;
          for (const [id, record] of Object.entries(entry)) records[id] = record;
        }
      }
    } finally {
      reader.close();
    }
    if (seq === null) return null;
    if (!ended) throw new SyntaxError('the records end early');
    return { records, seq };
  }

  // A snapshot in any other form, read whole: what an older relay wrote.
  private async readSnapshotWhole(file: string): Promise<Snapshot | null> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(raw) as SubscriptionsFile;
    if (!parsed || typeof parsed.records !== 'object' || parsed.records === null) {
      throw new SyntaxError('no records in the file');
    }
    return { records: parsed.records, seq: isSeq(parsed.seq) ? parsed.seq : null };
  }

  // Creates the data directory for the relay's user alone, and narrows the
  // directory and the store's files where an earlier relay or an operator left
  // them readable by others. What can't be changed is logged, not fatal: the
  // first write says whether the directory works at all.
  private async makePrivate(): Promise<void> {
    const dir = getPushDir();
    try {
      await mkdir(dir, { recursive: true, mode: PRIVATE_DIR });
      if (!POSIX) return;
      const mode = (await stat(dir)).mode & 0o777;
      if (mode & 0o077) {
        await chmod(dir, PRIVATE_DIR);
        logger.warn('store: the data directory was open to other users, now only the relay user has access', { was: mode.toString(8) });
      }
      for (const name of await readdir(dir)) {
        if (!name.startsWith('subscriptions.')) continue;
        const file = path.join(dir, name);
        const info = await stat(file);
        if (info.isFile() && info.mode & 0o077) await chmod(file, PRIVATE_FILE);
      }
    } catch (error) {
      logger.warn('store: could not make the data directory private', { error: message(error) });
    }
  }

  /**
   * Applies the changes since the snapshot. Says whether there was a journal to
   * fold. Changes the snapshot already holds are skipped, so a crash between a
   * snapshot's rename and the journal's removal applies nothing twice. A journal
   * that doesn't continue the snapshot loaded is set aside unread: its changes
   * don't follow from what is in memory. A journal always begins on a snapshot
   * with a number, so one next to a snapshot without a number, or none, means an
   * older relay wrote subscriptions.json since; one that began later than the
   * snapshot loaded means only the previous version could be read.
   */
  private async readJournal(): Promise<boolean> {
    let reader: Awaited<ReturnType<typeof fileLines>>;
    let from: number | null = null;
    let skipped = 0;
    let changes = 0;
    let stale = false;
    try {
      reader = await fileLines(journalPath());
      if (!reader) return false;
      try {
        // A line at a time: the journal can be as large as the snapshot.
        for await (const line of reader.lines) {
          if (!line) continue;
          let entry: { from?: unknown; seq?: unknown; id?: unknown; record?: unknown };
          try {
            entry = JSON.parse(line);
            if (from === null && isSeq(entry.from)) {
              from = entry.from;
              // A crash before a fold's journal removal leaves the journal next
              // to the snapshot it was folded into: a later number.
              if (!this.snapshotNumbered || from > this.snapshotSeq) {
                stale = true;
                break;
              }
              continue;
            }
            if (!isSeq(entry.seq) || typeof entry.id !== 'string' || entry.id === '__proto__') throw new Error('no change');
            if (entry.record !== null && (!entry.record || typeof entry.record !== 'object')) throw new Error('no record');
          } catch {
            // A crash in the middle of an append, which was never answered.
            skipped++;
            continue;
          }
          if (from === null) {
            stale = true;
            break;
          }
          changes++;
          if (entry.seq <= this.seq) continue;
          if (entry.record === null) this.records.delete(entry.id);
          else this.records.set(entry.id, entry.record as SubscriptionRecord);
          this.seq = entry.seq;
        }
      } finally {
        reader.close();
      }
    } catch (error) {
      logger.error('store: failed to read the journal', { error: message(error) });
      throw error;
    }
    if (skipped > 0) logger.warn('store: skipped journal lines that could not be read', { count: skipped });
    if (!stale && changes === 0 && from === null) {
      // Nothing in it: an append that failed before its first byte stuck, or a
      // first append a crash cut short, which was never answered. It goes, so the
      // next change starts a new journal and its size is counted from nothing.
      if (reader.size > 0) await unlink(journalPath());
      this.journalBytes = 0;
      return false;
    }
    if (stale) {
      const aside = `${journalPath()}.stale-${Date.now()}`;
      await rename(journalPath(), aside);
      if (POSIX) await chmod(aside, PRIVATE_FILE).catch(() => undefined);
      logger.warn('store: the journal does not continue the snapshot, set aside unread', {
        snapshotSeq: this.snapshotSeq,
        journalFrom: from,
        aside: path.basename(aside),
      });
      this.journalBytes = 0;
      return false;
    }
    this.journalBytes = reader.size;
    return true;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async get(id: string): Promise<SubscriptionRecord | null> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    if (!record) return null;
    if (this.isExpired(record)) {
      await this.deleteIfCurrent(id, record).catch(() => false);
      return null;
    }
    return record;
  }

  /**
   * Stores a record, registered from `address` (null when the relay can't tell).
   * The id is the first registration's: a record bound to a secret is replaced
   * only by one bound to the same secret ('not-owner' otherwise), and a record
   * without one is never bound to one in place ('taken'), so nobody who merely
   * knows an id can lock its client out. Past that, an id that is there can
   * always be replaced. A new id is refused when its address already has
   * `perAddress` records, and when the store holds `limit` records and none of
   * them may give way (see SETUP_GRACE_MS); otherwise the new record is written,
   * then the one that gives way is deleted and named in the result. Rejects when
   * the record can't be written, and then keeps the one before and the one that
   * would have given way.
   */
  async put(
    id: string,
    record: SubscriptionRecord,
    options: { limit?: number; address?: string | null; perAddress?: number } = {},
  ): Promise<PutResult> {
    await this.ensureLoaded();
    return this.serial(async (): Promise<PutResult> => {
      const address = options.address ?? null;
      const current = this.records.get(id);
      if (current) {
        if (!mayUse(current, record.secretHash ?? null)) return { stored: false, reason: 'not-owner' };
        if (current.secretHash === undefined && record.secretHash !== undefined) return { stored: false, reason: 'taken' };
      }
      let victim: string | null = null;
      if (!current) {
        if (address && (this.perAddress.get(address) ?? 0) >= (options.perAddress ?? Infinity)) {
          return { stored: false, reason: 'address-full' };
        }
        if (this.records.size >= (options.limit ?? Infinity)) {
          victim = this.givesWay(Date.now());
          if (victim === null) return { stored: false, reason: 'full' };
        }
      }
      await this.append(id, record);
      this.records.set(id, record);
      this.order(id, record, false);
      this.setOrigin(id, address);
      let evicted: { id: string; record: SubscriptionRecord } | undefined;
      if (victim !== null) {
        const gone = this.records.get(victim)!;
        try {
          await this.append(victim, null);
          this.forget(victim);
          evicted = { id: victim, record: gone };
        } catch {
          // Its delete isn't on disk, so it stays, and the store holds one
          // record more than its limit until a record leaves.
        }
      }
      await this.foldIfDue();
      return evicted ? { stored: true, evicted } : { stored: true };
    });
  }

  /** The client address the record was last registered from since the start, if the relay could tell. */
  addressOf(id: string): string | null {
    return this.origins.get(id) ?? null;
  }

  /**
   * Deletes a record, if the caller may (see mayUse; `secretHash` is the hash of
   * the secret it presented, null for none). Says what happened.
   */
  async delete(id: string, secretHash: string | null = null): Promise<'deleted' | 'absent' | 'not-owner'> {
    await this.ensureLoaded();
    return this.serial(async () => {
      const current = this.records.get(id);
      if (!current) return 'absent';
      if (!mayUse(current, secretHash)) return 'not-owner';
      await this.append(id, null);
      this.forget(id);
      await this.foldIfDue();
      return 'deleted';
    });
  }

  /**
   * Changes a record, if it is still the one the caller read. A registration or
   * a delete can come in while a push is on its way to the service; the caller's
   * copy is out of date then and must not be written back. The record changes in
   * place once the change is on disk, so it stays the current one.
   */
  async updateIfCurrent(
    id: string,
    expected: SubscriptionRecord,
    change: (record: SubscriptionRecord) => void,
  ): Promise<void> {
    await this.ensureLoaded();
    await this.serial(async () => {
      if (this.records.get(id) !== expected) return;
      const next = { ...expected };
      change(next);
      await this.append(id, next);
      const pushed = next.lastPushAt !== expected.lastPushAt;
      const collected = next.codeCollectedAt !== expected.codeCollectedAt;
      Object.assign(expected, next);
      if (pushed || collected) this.order(id, expected, pushed);
      await this.foldIfDue();
    });
  }

  async isCurrent(id: string, record: SubscriptionRecord): Promise<boolean> {
    await this.ensureLoaded();
    return this.records.get(id) === record;
  }

  /** Deletes a record, if it is still the one the caller read. Says whether it did. */
  async deleteIfCurrent(id: string, expected: SubscriptionRecord): Promise<boolean> {
    await this.ensureLoaded();
    return this.serial(async () => {
      if (this.records.get(id) !== expected) return false;
      await this.append(id, null);
      this.forget(id);
      await this.foldIfDue();
      return true;
    });
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    return this.records.size;
  }

  async sizeByKind(): Promise<{ fcm: number; apns: number; web: number; up: number }> {
    await this.ensureLoaded();
    let fcm = 0;
    let apns = 0;
    let web = 0;
    let up = 0;
    for (const record of this.records.values()) {
      if (record.kind === 'fcm') fcm++;
      else if (record.kind === 'apns') apns++;
      else if (record.kind === 'web') web++;
      else if (record.kind === 'up') up++;
    }
    return { fcm, apns, web, up };
  }

  /**
   * Folds the journal into the snapshot, after every change already on its way,
   * and takes no change after that: an older relay reads subscriptions.json only.
   * Then gives up the data directory's lock. Says whether the journal is gone.
   */
  async close(): Promise<boolean> {
    if (!this.loaded) return true;
    const folded = await this.serial(async () => {
      this.closed = true;
      if (this.journalBytes > 0) await this.fold();
      return true;
    }).catch(() => false);
    await this.releaseLock();
    return folded;
  }

  private isExpired(record: SubscriptionRecord, now = Date.now()): boolean {
    const age = now - Math.max(record.lastPushAt ?? 0, record.lastRegisteredAt ?? 0, record.createdAt);
    const used = record.lastPushAt != null || record.codeCollectedAt != null;
    return age > (used ? TTL_MS : UNUSED_TTL_MS);
  }

  private evictExpired(): void {
    for (const [id, record] of this.records) {
      if (this.isExpired(record)) this.records.delete(id);
    }
  }

  /** Writes a snapshot without the expired records, then forgets them. */
  async sweep(now = Date.now()): Promise<number> {
    await this.ensureLoaded();
    return this.serial(async () => {
      const expired = new Set<string>();
      for (const [id, record] of this.records) if (this.isExpired(record, now)) expired.add(id);
      if (expired.size === 0) return 0;
      await this.fold(expired);
      for (const id of expired) this.forget(id);
      return expired.size;
    });
  }

  // A record's place in the order of who gives way first. A registration, or a
  // code collected, puts one that never delivered at the end of its order; one
  // that delivered moves only when it delivers again (`moved`), so its place
  // says how long ago that was.
  private order(id: string, record: SubscriptionRecord, moved: boolean): void {
    if (record.lastPushAt == null) {
      this.delivered.delete(id);
      this.unconfirmed.delete(id);
      this.confirmed.delete(id);
      (record.codeCollectedAt == null ? this.unconfirmed : this.confirmed).set(id, true);
    } else {
      this.unconfirmed.delete(id);
      this.confirmed.delete(id);
      if (moved) this.delivered.delete(id);
      this.delivered.set(id, true);
    }
  }

  private setOrigin(id: string, address: string | null): void {
    const before = this.origins.get(id) ?? null;
    if (before === address) return;
    if (before) {
      const count = (this.perAddress.get(before) ?? 1) - 1;
      if (count > 0) this.perAddress.set(before, count);
      else this.perAddress.delete(before);
    }
    if (address) {
      this.origins.set(id, address);
      this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
    } else {
      this.origins.delete(id);
    }
  }

  private forget(id: string): void {
    this.records.delete(id);
    this.unconfirmed.delete(id);
    this.confirmed.delete(id);
    this.delivered.delete(id);
    this.setOrigin(id, null);
  }

  // The record a new device takes the place of in a full store, or null: see
  // SETUP_GRACE_MS. The first of each order is the only candidate there. While
  // the first record without a collected code is in its first minutes, every
  // other one is too, and no record with a code goes before them.
  private givesWay(now: number): string | null {
    const unconfirmed = this.unconfirmed.keys().next();
    const neverDelivered = unconfirmed.done ? this.confirmed.keys().next() : unconfirmed;
    if (!neverDelivered.done) {
      const record = this.records.get(neverDelivered.value);
      if (record && now - registeredAt(record) > SETUP_GRACE_MS) return neverDelivered.value;
    }
    const oldest = this.delivered.keys().next();
    if (!oldest.done) {
      const record = this.records.get(oldest.value);
      if (record?.lastPushAt != null && now - record.lastPushAt > RECENTLY_WORKED_MS) return oldest.value;
    }
    return null;
  }

  // Records written before the FCM/Web Push split only had `fcmToken`. Stamp
  // them with `kind: 'fcm'` so the dispatcher in server.ts can branch on it.
  private migrateLegacyRecords(): void {
    for (const [id, record] of this.records) {
      const r = record as Partial<SubscriptionRecord> & { fcmToken?: string };
      if (!r.kind && typeof r.fcmToken === 'string') {
        this.records.set(id, { ...(r as object), kind: 'fcm' } as SubscriptionRecord);
      }
    }
  }

  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // One line, on disk before the caller hears back, with the next number. Its
  // cost doesn't depend on how many records there are. A new journal starts with
  // the snapshot it continues. On a snapshot without a number (an older relay's,
  // or none) the first change writes a snapshot of this relay's own first, so no
  // journal ever continues one an older relay could rewrite; should that fail,
  // the change is refused, and so is every change until the next try, a minute later.
  private async append(id: string, record: SubscriptionRecord | null): Promise<void> {
    if (this.closed) throw new Error('the store is closed');
    if (record && recordBytes(record) > MAX_RECORD_BYTES) throw new Error('the record is larger than a record may be');
    if (this.journalBytes === 0 && !this.snapshotNumbered) {
      if (Date.now() < this.foldRetryAt) {
        storeWriteFailures.inc();
        throw new Error('the first snapshot could not be written; it is tried again a minute after the last try');
      }
      await this.fold().catch((error: unknown) => {
        this.foldRetryAt = Date.now() + FOLD_RETRY_MS;
        throw error;
      });
    }
    const seq = this.seq + 1;
    const header = this.journalBytes === 0 ? `\n${JSON.stringify({ from: this.snapshotSeq })}` : '';
    const line = `${header}\n${JSON.stringify({ seq, id, record })}`;
    // Where this append begins in the file, once it is open.
    let start: number | null = null;
    try {
      await mkdir(getPushDir(), { recursive: true, mode: PRIVATE_DIR });
      const handle = await open(journalPath(), 'a', PRIVATE_FILE);
      try {
        start = (await handle.stat()).size;
        await handle.writeFile(line, 'utf-8');
        await handle.datasync();
      } finally {
        await handle.close();
      }
      if (header) await syncDirectory();
    } catch (error) {
      storeWriteFailures.inc();
      logger.error('store: could not write a change', { error: message(error) });
      // Nothing of a change that was refused may stay behind, and nothing that
      // was there before it may go: the cut is back to where it began. Should
      // that fail, its number is used up, so a whole line of it can't pass for
      // the next.
      if (start !== null) {
        await truncate(journalPath(), start).catch(() => {
          this.seq = seq;
        });
      }
      throw error;
    }
    this.seq = seq;
    this.journalBytes = (start ?? 0) + Buffer.byteLength(line);
  }

  // After the change is in memory: the snapshot written now holds it. The
  // change is on disk in the journal already, so a snapshot that fails costs
  // nothing but a later try.
  private async foldIfDue(): Promise<void> {
    if (this.journalBytes <= Math.max(this.snapshotBytes, MIN_FOLD_BYTES) || Date.now() < this.foldRetryAt) return;
    await this.fold().catch(() => {
      this.foldRetryAt = Date.now() + FOLD_RETRY_MS;
    });
  }

  // A new snapshot with every record in memory but the ones left out, numbered
  // with the last change, written aside and renamed into place; the one it
  // replaces stays as the previous version. Only then does the journal go.
  private async fold(leaveOut?: Set<string>): Promise<void> {
    const target = subscriptionsPath();
    const tmp = `${target}.tmp`;
    let bytes = 0;
    try {
      await mkdir(getPushDir(), { recursive: true, mode: PRIVATE_DIR });
      // On disk before the rename: a power cut must not leave a renamed, empty file.
      const handle = await open(tmp, 'w', PRIVATE_FILE);
      try {
        // A leftover from a crash keeps the mode it had.
        if (POSIX) await handle.chmod(PRIVATE_FILE);
        let chunk = `{"seq":${this.seq},"records":{`;
        let count = 0;
        for (const [id, record] of this.records) {
          if (leaveOut?.has(id)) continue;
          chunk += `\n${count === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(record)}`;
          count++;
          if (count % SNAPSHOT_BATCH === 0) {
            await handle.writeFile(chunk, 'utf-8');
            bytes += Buffer.byteLength(chunk);
            chunk = '';
          }
        }
        chunk += '\n}}';
        await handle.writeFile(chunk, 'utf-8');
        bytes += Buffer.byteLength(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A crash between these two leaves the previous version, which load reads,
      // and the journal that continues it.
      await rename(target, previousVersionPath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(tmp, target);
      await syncDirectory();
      this.snapshotSeq = this.seq;
      this.snapshotNumbered = true;
      this.snapshotBytes = bytes;
      // A crash before this leaves a journal whose changes the snapshot holds
      // already: load skips them by their numbers.
      await unlink(journalPath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } catch (error) {
      storeWriteFailures.inc();
      logger.error('store: could not write a snapshot', { error: message(error) });
      throw error;
    }
    this.journalBytes = 0;
  }
}

export const subscriptionStore = new SubscriptionStore();
