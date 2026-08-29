"use client";

/**
 * Durable upload queue for live-recording fragments.
 *
 * The recorder hands over a blob every few seconds. Uploading it straight from
 * the event handler means a failed request loses that slice of the recording
 * for good — and the failure window is exactly when it hurts (flaky wifi,
 * sleeping laptop, a tab being closed).
 *
 * Every fragment is written to IndexedDB first and only deleted once storage
 * has acknowledged it. Uploads are retried with backoff, and anything still
 * queued when the tab dies is picked up and flushed on the next page load.
 *
 * Registration is idempotent server-side (upsert on videoId+index), so retrying
 * a fragment whose PUT failed after its POST succeeded is safe.
 */

const DB_NAME = "clipper-live";
const DB_VERSION = 1;
const STORE = "outbox";

export interface OutboxStats {
  /** Fragments written to storage and confirmed. */
  uploaded: number;
  /** Fragments waiting or in flight. */
  pending: number;
  /** Consecutive failures on the head of the queue; 0 when healthy. */
  failures: number;
}

interface Row {
  key?: number;
  videoId: string;
  index: number;
  startMs: number;
  mime: string;
  bytes: number;
  blob: Blob;
  attempts: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null); // storage disabled (private mode, blocked cookies)
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "key", autoIncrement: true });
        s.createIndex("videoId", "videoId", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

const tx = <T,>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Persist-then-upload queue. One instance per page; `drain` is single-flight so
 * concurrent calls (a new fragment, a reconnect, a visibility change) collapse
 * into the one in-flight pass.
 */
export class LiveOutbox {
  private db: IDBDatabase | null = null;
  private opened = false;
  /** Fallback when IndexedDB is unavailable — durable only for this page. */
  private memory: Row[] = [];
  private nextMemKey = 1;
  private draining = false;
  private stopped = false;
  private uploaded = 0;
  private failures = 0;
  private readonly onChange?: (s: OutboxStats) => void;

  constructor(onChange?: (s: OutboxStats) => void) {
    this.onChange = onChange;
  }

  private async ready(): Promise<IDBDatabase | null> {
    if (!this.opened) {
      this.opened = true;
      this.db = typeof indexedDB === "undefined" ? null : await openDb();
    }
    return this.db;
  }

  private async all(): Promise<Row[]> {
    const db = await this.ready();
    if (!db) return [...this.memory];
    try {
      const rows = await tx<Row[]>(db, "readonly", (s) => s.getAll() as IDBRequest<Row[]>);
      return rows.sort((a, b) => (a.key ?? 0) - (b.key ?? 0));
    } catch {
      return [...this.memory];
    }
  }

  private async remove(key: number): Promise<void> {
    const db = await this.ready();
    if (!db) {
      this.memory = this.memory.filter((r) => r.key !== key);
      return;
    }
    try {
      await tx(db, "readwrite", (s) => s.delete(key));
    } catch {
      /* best effort */
    }
  }

  private async bump(row: Row): Promise<void> {
    const db = await this.ready();
    if (!db) return;
    try {
      await tx(db, "readwrite", (s) => s.put(row));
    } catch {
      /* best effort */
    }
  }

  private async emit(): Promise<void> {
    this.onChange?.({
      uploaded: this.uploaded,
      pending: (await this.all()).length,
      failures: this.failures,
    });
  }

  /** Queue a fragment. Resolves once it is durable, not once it is uploaded. */
  async add(item: Omit<Row, "key" | "attempts">): Promise<void> {
    const row: Row = { ...item, attempts: 0 };
    const db = await this.ready();
    if (db) {
      try {
        await tx(db, "readwrite", (s) => s.add(row) as IDBRequest<IDBValidKey>);
      } catch {
        this.memory.push({ ...row, key: this.nextMemKey++ });
      }
    } else {
      this.memory.push({ ...row, key: this.nextMemKey++ });
    }
    void this.emit();
    void this.drain();
  }

  /**
   * Upload everything queued, oldest first. Stops at the first fragment that
   * won't go through, so ordering is preserved and the head is retried next
   * pass rather than skipped.
   */
  async drain(): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const rows = await this.all();
        if (rows.length === 0) {
          this.failures = 0;
          void this.emit();
          return;
        }
        const row = rows[0];
        try {
          await this.upload(row);
          await this.remove(row.key!);
          this.uploaded++;
          this.failures = 0;
          void this.emit();
        } catch {
          row.attempts++;
          this.failures = row.attempts;
          await this.bump(row);
          void this.emit();
          // Back off, then let the next trigger retry the same head.
          await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(row.attempts, 5)));
          return;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async upload(row: Row): Promise<void> {
    const res = await fetch(`/api/live/${row.videoId}/chunk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        index: row.index,
        startMs: row.startMs,
        contentType: row.mime,
        bytes: row.bytes,
      }),
    });
    if (res.status === 409) return; // session already finalised — nothing to do
    if (!res.ok) throw new Error(`register ${row.index}: HTTP ${res.status}`);
    const { upload } = (await res.json()) as {
      upload: { url: string; method: string; headers: Record<string, string> };
    };
    const put = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: row.blob,
      // Let the request outlive a closing tab where the browser allows it.
      keepalive: row.blob.size < 60_000,
    });
    if (!put.ok) throw new Error(`upload ${row.index}: HTTP ${put.status}`);
  }

  /** Fragments still queued, across all sessions. */
  async pending(): Promise<number> {
    return (await this.all()).length;
  }

  /** Distinct sessions with unsent fragments — used to flush after a reload. */
  async pendingSessions(): Promise<string[]> {
    return [...new Set((await this.all()).map((r) => r.videoId))];
  }

  /** Wait for the queue to empty, or give up after `timeoutMs`. */
  async flush(timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.drain();
      if ((await this.pending()) === 0) return true;
      await sleep(500);
    }
    return (await this.pending()) === 0;
  }

  stop(): void {
    this.stopped = true;
  }
}
