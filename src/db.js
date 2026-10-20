// SQLite persistence (node:sqlite, Node >= 22.13). One file holds the idempotency store, free-tier counters
// and treasury state, so they survive a restart. WAL + synchronous=FULL; every mutation is one transaction.
// Failure policy: a corrupt or unreadable DB refuses to open (StoreUnavailableError); a locked DB waits up to
// busyTimeoutMs, then throws. Callers fail CLOSED on money paths (no free credit, no sale, 503).
// Lock scope: SQLite file locks make this safe for several processes on ONE host sharing one file.
// It is NOT safe across hosts (NFS, two machines): run one treasury per DB file.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class StoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "StoreUnavailableError";
    this.code = "store_unavailable";
    this.cause = cause;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending','done')),
  status INTEGER,
  body TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS free_tier (
  digest TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS treasury (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export function openDb(path, { busyTimeoutMs = 2000 } = {}) {
  if (!path) throw new TypeError("openDb needs a path (or ':memory:')");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)};`);
    const qc = db.prepare("PRAGMA quick_check").get();
    const verdict = qc && Object.values(qc)[0];
    if (verdict !== "ok") throw new Error("quick_check: " + verdict);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    db.exec(SCHEMA);
    db.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', '1')").run();
  } catch (e) {
    try { db?.close(); } catch { /* ignore */ }
    throw new StoreUnavailableError(`gatecheck db unavailable (${path}): ${e?.message || e}`, e);
  }
  return wrap(db);
}

function wrap(db) {
  let depth = 0;
  return {
    raw: db,
    prepare: (sql) => db.prepare(sql),
    /** Run fn inside BEGIN IMMEDIATE ... COMMIT (rollback on throw). Re-entrant. */
    tx(fn) {
      if (depth > 0) return fn();
      try { db.exec("BEGIN IMMEDIATE"); }
      catch (e) { throw new StoreUnavailableError("gatecheck db busy or unavailable: " + (e?.message || e), e); }
      depth++;
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => db.close(),
  };
}
