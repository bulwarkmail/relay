import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, open, mkdir, rename, unlink, chmod, readdir, stat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from './logger.js';
import { storeWriteFailures } from './metrics.js';
import type { SubscriptionRecord } from './types.js';

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
// delivered a push (the one registered longest ago first), then of the record
// whose last push is the oldest. Never of one registered in the last 10 minutes,
// which may be a device in the middle of its setup, and never of one that
// delivered a push in the last 30 days.
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
// Snapshots without a number are told apart by a hash of their bytes.
function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

function previousVersionPath(): string {
  return `${subscriptionsPath()}.bak`;
}

// The changes since a snapshot: a first line naming the snapshot they continue,
// {"from":<its seq>,"snapshot":<a hash of its bytes, null without one>}, then
// one line per change, {"seq":n,"id":..,"record":{..}}, or "record":null for a
// delete, numbered on from there. Each line starts with its newline, so an
// append cut short by a crash stays a line of its own, which the next load skips.
function journalPath(): string {
  return path.join(getPushDir(), 'subscriptions.journal');
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

/**
 * The lines of a file, one at a time, and its bytes into `hash` as they are read.
 * A file that can't be read throws; a missing one says null.
 */
async function fileLines(file: string, hash?: Hash): Promise<{ lines: AsyncIterable<string>; size: number; close(): void } | null> {
  let size: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw Object.assign(new Error(`${path.basename(file)} is not a file`), { code: 'EISDIR' });
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  // Bytes, which the line reader decodes as UTF-8.
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  if (hash) input.on('data', (chunk) => hash.update(chunk));
  return { lines, size, close: () => { lines.close(); input.destroy(); } };
}

/** A whole file as text, with a hash of its bytes. */
async function wholeFile(file: string): Promise<{ text: string; hash: string }> {
  const bytes = await readFile(file);
  return { text: bytes.toString('utf-8'), hash: createHash('sha256').update(bytes).digest('hex') };
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
  // Of the file's bytes.
  hash: string;
}

export type PutResult =
  | { stored: true; evicted?: { id: string; record: SubscriptionRecord } }
  | { stored: false; reason: 'full' | 'address-full' };

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
  // so: one an older relay wrote has no number.
  private snapshotSeq = 0;
  private snapshotNumbered = false;
  // A hash of the snapshot's bytes, null while there is none. A journal names it
  // in its first line, so that a snapshot an older relay wrote since is told
  // apart from the one the journal continues even where neither has a number.
  private snapshotHash: string | null = null;
  private foldRetryAt = 0;
  private closed = false;
  // The client address each record was last registered from, while the relay
  // runs. Never written to disk: after a start a record has none until its
  // client registers again, which it does on every page load and app start.
  private origins = new Map<string, string>();
  // Records per client address, from `origins`.
  private perAddress = new Map<string, number>();
  // Who gives way first when the store is full. Records that never delivered a
  // push, in the order they were last registered, and records that did, in the
  // order of their last push. Maps keep the order they were set in.
  private neverDelivered = new Map<string, true>();
  private delivered = new Map<string, true>();

  /** Once, whoever asks. Rejects when a store exists that can't be read: see readSnapshot. */
  load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    await this.makePrivate();
    const snapshot =
      (await this.readSnapshot(subscriptionsPath())) ?? (await this.readSnapshot(previousVersionPath()));
    for (const [id, record] of Object.entries(snapshot?.records ?? {})) {
      if (id !== '__proto__') this.records.set(id, record);
    }
    this.seq = this.snapshotSeq = snapshot?.seq ?? 0;
    this.snapshotNumbered = snapshot != null && snapshot.seq !== null;
    this.snapshotHash = snapshot?.hash ?? null;
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
    const hash = createHash('sha256');
    const reader = await fileLines(file, hash);
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
    return { records, seq, hash: hash.digest('hex') };
  }

  // A snapshot in any other form, read whole: what an older relay wrote.
  private async readSnapshotWhole(file: string): Promise<Snapshot | null> {
    let raw: { text: string; hash: string };
    try {
      raw = await wholeFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const parsed = JSON.parse(raw.text) as SubscriptionsFile;
    if (!parsed || typeof parsed.records !== 'object' || parsed.records === null) {
      throw new SyntaxError('no records in the file');
    }
    return { records: parsed.records, seq: isSeq(parsed.seq) ? parsed.seq : null, hash: raw.hash };
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
   * that doesn't continue the snapshot loaded (an older relay wrote the snapshot
   * since, or only the previous version could be read) is set aside unread: its
   * changes don't follow from what is in memory. See continues().
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
          let entry: { from?: unknown; snapshot?: unknown; seq?: unknown; id?: unknown; record?: unknown };
          try {
            entry = JSON.parse(line);
            if (from === null && isSeq(entry.from)) {
              from = entry.from;
              if (!this.continues(from, entry.snapshot)) {
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

  /**
   * Whether a journal that began on snapshot `from`, with this hash, continues
   * the snapshot loaded. A snapshot this relay wrote has a number, which an older
   * relay's rewrite drops: the journal continues it when it began on it or on an
   * earlier one (a crash before the journal's removal leaves it next to the
   * snapshot it was folded into). A snapshot without a number, an older relay's
   * or none at all, is continued only by a journal that began on that very file.
   */
  private continues(from: number, snapshot: unknown): boolean {
    return this.snapshotNumbered ? from <= this.snapshotSeq : snapshot === this.snapshotHash;
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
   * An id that is there can always be replaced. A new id is refused when its
   * address already has `perAddress` records, and when the store holds `limit`
   * records and none of them may give way (see SETUP_GRACE_MS); otherwise the
   * one that gives way is deleted first and named in the result. Rejects when it
   * can't be written, and then keeps the one before.
   */
  async put(
    id: string,
    record: SubscriptionRecord,
    options: { limit?: number; address?: string | null; perAddress?: number } = {},
  ): Promise<PutResult> {
    await this.ensureLoaded();
    return this.serial(async (): Promise<PutResult> => {
      const address = options.address ?? null;
      let evicted: { id: string; record: SubscriptionRecord } | undefined;
      if (!this.records.has(id)) {
        if (address && (this.perAddress.get(address) ?? 0) >= (options.perAddress ?? Infinity)) {
          return { stored: false, reason: 'address-full' };
        }
        if (this.records.size >= (options.limit ?? Infinity)) {
          const victim = this.givesWay(Date.now());
          if (victim === null) return { stored: false, reason: 'full' };
          evicted = { id: victim, record: this.records.get(victim)! };
          await this.append(victim, null);
          this.forget(victim);
        }
      }
      await this.append(id, record);
      this.records.set(id, record);
      this.order(id, record, false);
      this.setOrigin(id, address);
      await this.foldIfDue();
      return evicted ? { stored: true, evicted } : { stored: true };
    });
  }

  /** The client address the record was last registered from since the start, if the relay could tell. */
  addressOf(id: string): string | null {
    return this.origins.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    await this.serial(async () => {
      if (!this.records.has(id)) return;
      await this.append(id, null);
      this.forget(id);
      await this.foldIfDue();
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
      Object.assign(expected, next);
      if (pushed) this.order(id, expected, true);
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
   * Says whether the journal is gone.
   */
  async close(): Promise<boolean> {
    if (!this.loaded) return true;
    return this.serial(async () => {
      this.closed = true;
      if (this.journalBytes > 0) await this.fold();
      return true;
    }).catch(() => false);
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

  // A record's place in the order of who gives way first. A registration puts
  // one that never delivered at the end; one that delivered moves only when it
  // delivers again (`moved`), so its place says how long ago that was.
  private order(id: string, record: SubscriptionRecord, moved: boolean): void {
    if (record.lastPushAt == null) {
      this.delivered.delete(id);
      this.neverDelivered.delete(id);
      this.neverDelivered.set(id, true);
    } else {
      this.neverDelivered.delete(id);
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
    this.neverDelivered.delete(id);
    this.delivered.delete(id);
    this.setOrigin(id, null);
  }

  // The record a new device takes the place of in a full store, or null: see
  // SETUP_GRACE_MS. The first of each order is the only candidate there.
  private givesWay(now: number): string | null {
    const first = this.neverDelivered.keys().next();
    if (!first.done) {
      const record = this.records.get(first.value);
      if (record && now - registeredAt(record) > SETUP_GRACE_MS) return first.value;
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
  // the snapshot it continues.
  private async append(id: string, record: SubscriptionRecord | null): Promise<void> {
    if (this.closed) throw new Error('the store is closed');
    if (record && recordBytes(record) > MAX_RECORD_BYTES) throw new Error('the record is larger than a record may be');
    const seq = this.seq + 1;
    const header = this.journalBytes === 0 ? `\n${JSON.stringify({ from: this.snapshotSeq, snapshot: this.snapshotHash })}` : '';
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
    const hash = createHash('sha256');
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
            hash.update(chunk);
            chunk = '';
          }
        }
        chunk += '\n}}';
        await handle.writeFile(chunk, 'utf-8');
        bytes += Buffer.byteLength(chunk);
        hash.update(chunk);
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
      this.snapshotHash = hash.digest('hex');
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
