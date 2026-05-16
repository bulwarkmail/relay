import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { SubscriptionRecord } from './types.js';

// Aligned with the JMAP PushSubscription expires the mobile client requests
// (90 days). The relay record gets refreshed on every push, so this only
// matters for users who go quiet for ~3 months.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

function getPushDir(): string {
  return process.env.PUSH_DATA_DIR || path.join(process.cwd(), 'data');
}

function subscriptionsPath(): string {
  return path.join(getPushDir(), 'subscriptions.json');
}

interface SubscriptionsFile {
  records: Record<string, SubscriptionRecord>;
}

class SubscriptionStore {
  private cache: Record<string, SubscriptionRecord> = {};
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const raw = await readFile(subscriptionsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as SubscriptionsFile;
      this.cache = parsed.records ?? {};
      this.migrateLegacyRecords();
      this.evictExpired();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {};
      } else {
        logger.warn('store: failed to read subscriptions', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.cache = {};
      }
    }
    this.loaded = true;
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

  async size(): Promise<number> {
    await this.ensureLoaded();
    return Object.keys(this.cache).length;
  }

  async sizeByKind(): Promise<{ fcm: number; web: number }> {
    await this.ensureLoaded();
    let fcm = 0;
    let web = 0;
    for (const record of Object.values(this.cache)) {
      if (record.kind === 'fcm') fcm++;
      else if (record.kind === 'web') web++;
    }
    return { fcm, web };
  }

  private isExpired(record: SubscriptionRecord): boolean {
    const age = Date.now() - (record.lastPushAt ?? record.createdAt);
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

  private persist(): Promise<void> {
    const next = this.writeQueue.then(() => this.flush());
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
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await rename(tmp, target);
  }
}

export const subscriptionStore = new SubscriptionStore();
