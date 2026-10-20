// Idempotency: the Idempotency-Key header dedups retried purchases.
// A retried key returns the ORIGINAL stored response — never a second
// fulfillment and never a second charge. Entries expire after 24h.
// fulfill-after-settlement: call .store() only AFTER the buyer's payment is
// verified AND fulfillment succeeded.

export function createIdempotencyStore({ ttlMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
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
    _size: () => store.size,
  };
}
