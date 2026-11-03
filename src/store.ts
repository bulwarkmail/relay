import { readFile, open, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { SubscriptionRecord } from './types.js';

// Aligned with the JMAP PushSubscription expires the mobile client requests
// (90 days). A push or a registration refreshes the record, so this only
// matters for devices that have gone away for good.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

function getPushDir(): string {
  return process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data');
}

function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

function previousVersionPath(): string {
  return `${subscriptionsPath()}.bak`;
}

interface SubscriptionsFile {
  records: Record<string, SubscriptionRecord>;
}

class SubscriptionStore {
  // Without a prototype, so no id can ever read or write an inherited property.
  private cache: Record<string, SubscriptionRecord> = Object.create(null);
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private queuedWrite: Promise<void> | null = null;
  private loading: Promise<void> | null = null;

  /** Once, whoever asks. Rejects when a store exists that can't be read: see readRecords. */
  load(): Promise<void> {
    this.loading ??= this.readFromDisk();
    return this.loading;
  }

  private async readFromDisk(): Promise<void> {
    const target = subscriptionsPath();
    const records =
      (await this.readRecords(target)) ?? (await this.readRecords(previousVersionPath()));
    this.cache = Object.assign(Object.create(null), records ?? {});
    delete this.cache['__proto__'];
    this.migrateLegacyRecords();
    this.evictExpired();
    this.loaded = true;
  }

  // Null when the file is missing or unusable. An unusable file is moved aside,
  // not left for the next write to replace: it may be every device's only
  // record, and one register call would otherwise wipe it.
  private async readRecords(file: string): Promise<Record<string, SubscriptionRecord> | null> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Unreadable, not missing: permissions, a bad mount. Starting empty would
      // replace every device's record with the next write, so this stops here.
      logger.error('store: failed to read subscriptions', {
        file: path.basename(file),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as SubscriptionsFile;
      if (!parsed || typeof parsed.records !== 'object' || parsed.records === null) {
        throw new Error('no records in the file');
      }
      return parsed.records;
    } catch (error) {
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => undefined);
      logger.error('store: subscriptions file is corrupt, moved aside', {
        file: path.basename(file),
        aside: path.basename(aside),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  async get(id: string): Promise<SubscriptionRecord | null> {
    await this.ensureLoaded();
    const record = this.cache[id];
    if (!record) return null;
    if (this.isExpired(record)) {
      delete this.cache[id];
      await this.persist();
      return null;
    }
    return record;
  }

  async put(id: string, record: SubscriptionRecord): Promise<void> {
    await this.ensureLoaded();
    this.cache[id] = record;
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    if (id in this.cache) {
      delete this.cache[id];
      await this.persist();
    }
  }

  /**
   * Changes a record, if it is still the one the caller read. A registration or
   * a delete can come in while a push is on its way to the service; the caller's
   * copy is out of date then and must not be written back.
   */
  async updateIfCurrent(
    id: string,
    expected: SubscriptionRecord,
    change: (record: SubscriptionRecord) => void,
  ): Promise<void> {
    await this.ensureLoaded();
    if (this.cache[id] !== expected) return;
    change(expected);
    await this.persist();
  }

  async isCurrent(id: string, record: SubscriptionRecord): Promise<boolean> {
    await this.ensureLoaded();
    return this.cache[id] === record;
  }

  /** Deletes a record, if it is still the one the caller read. Says whether it did. */
  async deleteIfCurrent(id: string, expected: SubscriptionRecord): Promise<boolean> {
    await this.ensureLoaded();
    if (this.cache[id] !== expected) return false;
    delete this.cache[id];
    await this.persist();
    return true;
  }

  async size(): Promise<number> {
    await this.ensureLoaded();
    return Object.keys(this.cache).length;
  }

  async sizeByKind(): Promise<{ fcm: number; apns: number; web: number; up: number }> {
    await this.ensureLoaded();
    let fcm = 0;
    let apns = 0;
    let web = 0;
    let up = 0;
    for (const record of Object.values(this.cache)) {
      if (record.kind === 'fcm') fcm++;
      else if (record.kind === 'apns') apns++;
      else if (record.kind === 'web') web++;
      else if (record.kind === 'up') up++;
    }
    return { fcm, apns, web, up };
  }

  private isExpired(record: SubscriptionRecord): boolean {
    const age = Date.now() - Math.max(record.lastPushAt ?? 0, record.lastRegisteredAt ?? 0, record.createdAt);
    return age > TTL_MS;
  }

  private evictExpired(): void {
    for (const [id, record] of Object.entries(this.cache)) {
      if (this.isExpired(record)) delete this.cache[id];
    }
  }

  // Records written before the FCM/Web Push split only had `fcmToken`. Stamp
  // them with `kind: 'fcm'` so the dispatcher in server.ts can branch on it.
  private migrateLegacyRecords(): void {
    for (const [id, record] of Object.entries(this.cache)) {
      const r = record as Partial<SubscriptionRecord> & { fcmToken?: string };
      if (!r.kind && typeof r.fcmToken === 'string') {
        this.cache[id] = { ...(r as object), kind: 'fcm' } as SubscriptionRecord;
      }
    }
  }

  // Every write replaces the whole file, so a write that hasn't started yet takes
  // along whatever changes meanwhile: a burst makes two writes, not one per call.
  private persist(): Promise<void> {
    if (this.queuedWrite) return this.queuedWrite;
    const next = this.writeQueue.then(() => {
      this.queuedWrite = null;
      return this.flush();
    });
    this.queuedWrite = next;
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async flush(): Promise<void> {
    const dir = getPushDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const target = subscriptionsPath();
    const tmp = target + '.tmp';
    const payload: SubscriptionsFile = { records: this.cache };
    // On disk before the rename: a power cut must not leave a renamed, empty file.
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2), 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A crash between these two leaves only the previous version, which load reads.
    await rename(target, previousVersionPath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await rename(tmp, target);
  }
}

export const subscriptionStore = new SubscriptionStore();
