// Idempotency: the Idempotency-Key header dedups retried purchases.
// A retried key returns the ORIGINAL stored response — never a second
// fulfillment and never a second charge. Entries expire after 24h.
// fulfill-after-settlement: call .store() only AFTER the buyer's payment is
// verified AND fulfillment succeeded.

export function createIdempotencyStore({ ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now(), db = null } = {}) {
  if (db) return createSqliteIdempotency({ ttlMs, now, db });
  const store = new Map(); // Map<key, { status, body, at }>
  const sweep = () => {
    const at = now();
    for (const [k, v] of store) if (at - v.at > ttlMs) store.delete(k);
  };
  return {
    /** Returns the stored response if this key was already fulfilled, else null. */
    check(key) {
      if (!key) return null;
      sweep();
      const hit = store.get(key);
      return hit ? { status: hit.status, body: hit.body, replay: true } : null;
    },
    /** Record a fulfilled response. Call only after settlement + fulfillment. */
    store(key, status, body) {
      if (!key) return;
      sweep();
      store.set(key, { status, body, at: now() });
    },
    /** Claim a key before fulfilling. true = this caller owns it; false = already pending or done. */
    claim(key) {
      if (!key) return true;
      sweep();
      if (store.has(key)) return false;
      store.set(key, { pending: true, at: now() });
      return true;
    },
    /** Drop a pending claim (fulfillment failed), so a retry can run. Never drops a done entry. */
    release(key) {
      const v = key && store.get(key);
      if (v && v.pending) store.delete(key);
    },
    _size: () => store.size,
  };
}

function createSqliteIdempotency({ ttlMs, now, db }) {
  const del = db.prepare("DELETE FROM idempotency WHERE at < ?");
  const get = db.prepare("SELECT state, status, body FROM idempotency WHERE key = ?");
  const ins = db.prepare("INSERT OR IGNORE INTO idempotency (key, state, at) VALUES (?, 'pending', ?)");
  const done = db.prepare("INSERT INTO idempotency (key, state, status, body, at) VALUES (?, 'done', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state='done', status=excluded.status, body=excluded.body, at=excluded.at WHERE idempotency.state = 'pending'");
  const rel = db.prepare("DELETE FROM idempotency WHERE key = ? AND state = 'pending'");
  const count = db.prepare("SELECT COUNT(*) AS n FROM idempotency");
  const sweep = () => del.run(now() - ttlMs);
  return {
    check(key) {
      if (!key) return null;
      return db.tx(() => {
        sweep();
        const hit = get.get(key);
        if (!hit) return null;
        if (hit.state === "pending") return { status: 409, body: { error: "in_progress", detail: "a request with this Idempotency-Key is still being fulfilled" }, replay: true, pending: true };
        return { status: hit.status, body: JSON.parse(hit.body), replay: true };
      });
    },
    claim(key) {
      if (!key) return true;
      return db.tx(() => { sweep(); return Number(ins.run(key, now()).changes) === 1; });
    },
    store(key, status, body) {
      if (!key) return;
      db.tx(() => { sweep(); done.run(key, status, JSON.stringify(body), now()); });
    },
    release(key) {
      if (key) db.tx(() => rel.run(key));
    },
    _size: () => Number(count.get().n),
  };
}
