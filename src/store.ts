import { readFile, open, mkdir, rename, unlink, chmod, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
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

// The journal is folded into a new snapshot once it is larger than the snapshot,
// and not before it holds this much: a change costs one append, and the snapshot
// is written once per as many bytes of changes as it holds itself.
const MIN_FOLD_BYTES = 1024 * 1024;
// Records per write while a snapshot goes to disk, so no string holds the whole store.
const SNAPSHOT_BATCH = 500;

// The store holds every device's endpoint, keys and token: the relay's own user
// alone may read it. File modes mean nothing on Windows.
const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
const POSIX = process.platform !== 'win32';

function getPushDir(): string {
  return process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data');
}

function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

function previousVersionPath(): string {
  return `${subscriptionsPath()}.bak`;
}

// Every change since the snapshot, one JSON line each: {"id":..,"record":{..}}, or
// "record":null for a delete. Each line starts with its newline, so an append cut
// short by a crash stays a line of its own, which the next load skips.
function journalPath(): string {
  return path.join(getPushDir(), 'subscriptions.journal');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

interface SubscriptionsFile {
  records: Record<string, SubscriptionRecord>;
}

class SubscriptionStore {
  private records = new Map<string, SubscriptionRecord>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  // One write at a time, in the order the changes came in.
  private queue: Promise<unknown> = Promise.resolve();
  private snapshotBytes = 0;
  private journalBytes = 0;

  /** Once, whoever asks. Rejects when a store exists that can't be read: see readSnapshot. */
  load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    await this.makePrivate();
    const records =
      (await this.readSnapshot(subscriptionsPath())) ?? (await this.readSnapshot(previousVersionPath()));
    for (const [id, record] of Object.entries(records ?? {})) {
      if (id !== '__proto__') this.records.set(id, record);
    }
    const journal = await this.readJournal();
    this.migrateLegacyRecords();
    this.evictExpired();
    this.loaded = true;
    // Starts the next journal from what is on disk now. Should that fail, the
    // journal stays, and the next start reads it again.
    if (journal) await this.serial(() => this.fold()).catch(() => undefined);
    setInterval(() => void this.sweep().catch(() => undefined), SWEEP_INTERVAL_MS).unref();
  }

  // Null when the file is missing or unusable. An unusable file is moved aside,
  // not left for the next write to replace: it may be every device's only
  // record, and one register call would otherwise wipe it.
  private async readSnapshot(file: string): Promise<Record<string, SubscriptionRecord> | null> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Unreadable, not missing: permissions, a bad mount. Starting empty would
      // replace every device's record with the next write, so this stops here.
      logger.error('store: failed to read subscriptions', { file: path.basename(file), error: message(error) });
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as SubscriptionsFile;
      if (!parsed || typeof parsed.records !== 'object' || parsed.records === null) {
        throw new Error('no records in the file');
      }
      this.snapshotBytes = Buffer.byteLength(raw);
      return parsed.records;
    } catch (error) {
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

  /** Applies the changes since the snapshot. Says whether there was a journal. */
  private async readJournal(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(journalPath(), 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      logger.error('store: failed to read the journal', { error: message(error) });
      throw error;
    }
    let skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { id?: unknown; record?: unknown };
        if (typeof entry.id !== 'string' || entry.id === '__proto__') throw new Error('no id');
        if (entry.record === null) this.records.delete(entry.id);
        else if (entry.record && typeof entry.record === 'object') this.records.set(entry.id, entry.record as SubscriptionRecord);
        else throw new Error('no record');
      } catch {
        // A crash in the middle of an append, which was never answered.
        skipped++;
      }
    }
    if (skipped > 0) logger.warn('store: skipped journal lines that could not be read', { count: skipped });
    this.journalBytes = Buffer.byteLength(raw);
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
   * Stores a record. False, and nothing stored, when the id is new and the store
   * already holds `limit` records: an id that is there can always be replaced.
   * Rejects when it can't be written, and then keeps the one before.
   */
  async put(id: string, record: SubscriptionRecord, limit = Infinity): Promise<boolean> {
    await this.ensureLoaded();
    return this.serial(async () => {
      if (!this.records.has(id) && this.records.size >= limit) return false;
      await this.append(id, record);
      this.records.set(id, record);
      return true;
    });
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    await this.serial(async () => {
      if (!this.records.has(id)) return;
      await this.append(id, null);
      this.records.delete(id);
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
      Object.assign(expected, next);
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
      this.records.delete(id);
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

  /** Folds the journal into the snapshot, so the next start reads one file. */
  async close(): Promise<void> {
    if (!this.loaded) return;
    await this.serial(async () => {
      if (this.journalBytes > 0) await this.fold();
    }).catch(() => undefined);
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
      for (const id of expired) this.records.delete(id);
      return expired.size;
    });
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

  // One line, on disk before the caller hears back. Its cost doesn't depend on
  // how many records there are.
  private async append(id: string, record: SubscriptionRecord | null): Promise<void> {
    const line = `\n${JSON.stringify({ id, record })}`;
    try {
      await mkdir(getPushDir(), { recursive: true, mode: PRIVATE_DIR });
      const handle = await open(journalPath(), 'a', PRIVATE_FILE);
      try {
        await handle.writeFile(line, 'utf-8');
        await handle.datasync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      storeWriteFailures.inc();
      logger.error('store: could not write a change', { error: message(error) });
      throw error;
    }
    this.journalBytes += Buffer.byteLength(line);
    if (this.journalBytes > Math.max(this.snapshotBytes, MIN_FOLD_BYTES)) {
      // The change is safe in the journal; a snapshot that fails is tried again
      // with the next change.
      await this.fold().catch(() => undefined);
    }
  }

  // A new snapshot with every record but the ones left out, written aside and
  // renamed into place; the one it replaces stays as the previous version. Only
  // then does the journal go.
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
        let chunk = '{"records":{';
        let count = 0;
        for (const [id, record] of this.records) {
          if (leaveOut?.has(id)) continue;
          chunk += `${count === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(record)}`;
          count++;
          if (count % SNAPSHOT_BATCH === 0) {
            await handle.writeFile(chunk, 'utf-8');
            bytes += Buffer.byteLength(chunk);
            chunk = '';
          }
        }
        chunk += '}}';
        await handle.writeFile(chunk, 'utf-8');
        bytes += Buffer.byteLength(chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A crash between these two leaves only the previous version, which load
      // reads, and the journal, which holds what the new snapshot added to it.
      await rename(target, previousVersionPath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await rename(tmp, target);
      // A crash before this replays the journal onto the snapshot that already
      // has it, which changes nothing: every line is a whole record or a delete.
      await unlink(journalPath()).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    } catch (error) {
      storeWriteFailures.inc();
      logger.error('store: could not write a snapshot', { error: message(error) });
      throw error;
    }
    this.snapshotBytes = bytes;
    this.journalBytes = 0;
  }
}

export const subscriptionStore = new SubscriptionStore();
