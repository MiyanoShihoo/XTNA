import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CacheConfig } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("cache");

export interface CacheEntry {
  payload: string;
  createdAt: number;
  hits: number;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

/**
 * Content-addressed store keyed by (upstream, method, canonical params).
 * Raw (pre-redaction) responses are stored so a cache hit can never leak a
 * secret that the live path would have masked.
 */
export class ResponseCache {
  private readonly db: DatabaseSync;
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private evictions = 0;

  constructor(private readonly config: CacheConfig) {
    mkdirSync(dirname(config.path), { recursive: true });
    this.db = new DatabaseSync(config.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key        TEXT PRIMARY KEY,
        upstream   TEXT NOT NULL,
        method     TEXT NOT NULL,
        payload    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        bytes      INTEGER NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at);
      CREATE INDEX IF NOT EXISTS idx_cache_upstream ON cache(upstream);
    `);
    this.prune();
  }

  get(key: string): CacheEntry | undefined {
    if (!this.config.enabled) return undefined;

    const row = this.db
      .prepare(
        "SELECT payload, created_at, hits, expires_at FROM cache WHERE key = ?",
      )
      .get(key) as
      | {
          payload: string;
          created_at: number;
          hits: number;
          expires_at: number;
        }
      | undefined;

    if (!row) {
      this.misses += 1;
      return undefined;
    }

    if (row.expires_at <= Date.now()) {
      this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
      this.misses += 1;
      return undefined;
    }

    this.db.prepare("UPDATE cache SET hits = hits + 1 WHERE key = ?").run(key);
    this.hits += 1;
    return {
      payload: row.payload,
      createdAt: row.created_at,
      hits: row.hits + 1,
    };
  }

  put(
    key: string,
    upstream: string,
    method: string,
    payload: string,
    ttlMs: number,
  ): void {
    if (!this.config.enabled) return;
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > this.config.maxEntryBytes) {
      log.debug("entry exceeds maxEntryBytes, skipping", {
        bytes,
        limit: this.config.maxEntryBytes,
      });
      return;
    }

    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cache (key, upstream, method, payload, created_at, expires_at, bytes, hits)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(key) DO UPDATE SET
           payload = excluded.payload,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           bytes = excluded.bytes`,
      )
      .run(key, upstream, method, payload, now, now + ttlMs, bytes);

    this.writes += 1;
    this.enforceLimit();
  }

  /** Drop entries for one upstream, or everything when omitted. */
  clear(upstream?: string): number {
    const before = this.count();
    if (upstream) {
      this.db.prepare("DELETE FROM cache WHERE upstream = ?").run(upstream);
    } else {
      this.db.exec("DELETE FROM cache");
    }
    return before - this.count();
  }

  prune(): number {
    const result = this.db
      .prepare("DELETE FROM cache WHERE expires_at <= ?")
      .run(Date.now());
    return Number(result.changes ?? 0);
  }

  stats(): CacheStats {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS entries, COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(hits), 0) AS hits FROM cache",
      )
      .get() as { entries: number; bytes: number; hits: number };

    return {
      entries: Number(row.entries),
      bytes: Number(row.bytes),
      hits: this.hits + Number(row.hits),
      misses: this.misses,
      writes: this.writes,
      evictions: this.evictions,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      log.warn("cache close failed", { message: (err as Error).message });
    }
  }

  private count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM cache").get() as {
      n: number;
    };
    return Number(row.n);
  }

  private enforceLimit(): void {
    const total = this.count();
    if (total <= this.config.maxEntries) return;

    const excess = total - this.config.maxEntries;
    // Evict expired first, then least-recently-hit.
    this.prune();
    const afterPrune = this.count();
    const remaining = Math.max(0, afterPrune - this.config.maxEntries);
    if (remaining === 0) return;

    this.db
      .prepare(
        `DELETE FROM cache WHERE key IN (
           SELECT key FROM cache ORDER BY hits ASC, created_at ASC LIMIT ?
         )`,
      )
      .run(Math.max(excess, remaining));
    this.evictions += Math.max(excess, remaining);
  }
}
