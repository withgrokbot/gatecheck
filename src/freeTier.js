// Free tier: 5 lite verdicts per client per UTC day.
// Identity = SHA-256("gatecheck:v1:" + clientId + ":" + utcDate).
// clientId prefers the x-client-id header; otherwise the request IP is hashed
// IMMEDIATELY — the raw IP is never assigned to a persisted variable.
// The store only ever holds 64-char hex digests.

import { createHash } from "node:crypto";

const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function clientDigest(req, at = Date.now()) {
  const headerId = req.get("x-client-id");
  // Hash the fallback input in the same expression — no raw IP is retained.
  const id = headerId && headerId.trim()
    ? `header:${headerId.trim().slice(0, 128)}`
    : `ip:${createHash("sha256").update(String(req.ip || "unknown")).digest("hex")}`;
  return createHash("sha256")
    .update(`gatecheck:v1:${id}:${dayKey(at)}`)
    .digest("hex");
}

export function createFreeTier({ perDay = 5, now = () => Date.now(), db = null } = {}) {
  if (db) return createSqliteFreeTier({ perDay, now, db });
  // Map<digest, { count, day }> — digests only, never raw identifiers.
  const store = new Map();
  return {
    /** Returns true and consumes one credit, or false when exhausted. */
    tryConsume(req) {
      const at = now();
      const key = clientDigest(req, at);
      const day = dayKey(at);
      const row = store.get(key);
      if (!row || row.day !== day) {
        store.set(key, { count: 1, day });
        return true;
      }
      if (row.count >= perDay) return false;
      row.count += 1;
      return true;
    },
    remaining(req) {
      const at = now();
      const row = store.get(clientDigest(req, at));
      if (!row || row.day !== dayKey(at)) return perDay;
      return Math.max(0, perDay - row.count);
    },
    // Exposed for tests: prove the store holds hashes, not identifiers.
    _store: store,
  };
}

// Persistent counters. One UPSERT per consume, so concurrent requests (and processes on one host) can never
// hand out more than perDay credits. On any DB error tryConsume returns false: fail closed, the caller pays.
function createSqliteFreeTier({ perDay, now, db }) {
  const upsert = db.prepare(`INSERT INTO free_tier (digest, day, count) VALUES (?, ?, 1)
    ON CONFLICT(digest) DO UPDATE SET
      count = CASE WHEN free_tier.day <> excluded.day THEN 1 ELSE free_tier.count + 1 END,
      day = excluded.day
    WHERE free_tier.day <> excluded.day OR free_tier.count < ?`);
  const get = db.prepare("SELECT day, count FROM free_tier WHERE digest = ?");
  const prune = db.prepare("DELETE FROM free_tier WHERE day < ?");
  const keys = db.prepare("SELECT digest FROM free_tier");
  return {
    tryConsume(req) {
      try {
        const at = now();
        const day = dayKey(at);
        return db.tx(() => {
          prune.run(day);
          return Number(upsert.run(clientDigest(req, at), day, perDay).changes) === 1;
        });
      } catch {
        return false;
      }
    },
    remaining(req) {
      const at = now();
      const row = get.get(clientDigest(req, at));
      if (!row || row.day !== dayKey(at)) return perDay;
      return Math.max(0, perDay - Number(row.count));
    },
    _store: { keys: () => keys.all().map((r) => r.digest)[Symbol.iterator]() },
  };
}
