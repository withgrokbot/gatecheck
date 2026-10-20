// Persistence, race and chaos tests for the SQLite stores (node:sqlite). Offline, temp files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, truncateSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openDb, StoreUnavailableError } from "../src/db.js";
import { createIdempotencyStore } from "../src/idempotency.js";
import { createFreeTier } from "../src/freeTier.js";
import { createTreasury } from "../src/treasury.js";

const A = (s) => BigInt(Math.round(Number(s) * 1_000_000));
const tmp = () => join(mkdtempSync(join(tmpdir(), "gatecheck-")), "g.db");
const req = (id) => ({ get: (h) => (h === "x-client-id" ? id : null), ip: "203.0.113.5" });
const SRC = new URL("../src/", import.meta.url).href;

function child(code, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code, signal) => resolve({ code, signal, out, err, proc: p }));
    resolve.proc = p;
  });
}

// ---- persistence -----------------------------------------------------------

test("state survives a restart: idempotency, free tier, treasury", () => {
  const path = tmp();
  let db = openDb(path);
  const idem = createIdempotencyStore({ db });
  assert.equal(idem.claim("k1"), true);
  idem.store("k1", 200, { receipt: { id: "r-1" } });
  const ft = createFreeTier({ perDay: 3, db });
  for (let i = 0; i < 3; i++) assert.equal(ft.tryConsume(req("agent")), true);
  const t = createTreasury({ db });
  t.recordSale({ kind: "full", priceAtomic: A("0.05"), upstreamAtomic: A("0.02") });
  t.kill("test");
  db.close();

  db = openDb(path); // "restart"
  const idem2 = createIdempotencyStore({ db });
  assert.deepEqual(idem2.check("k1"), { status: 200, body: { receipt: { id: "r-1" } }, replay: true });
  assert.equal(idem2.claim("k1"), false);
  const ft2 = createFreeTier({ perDay: 3, db });
  assert.equal(ft2.tryConsume(req("agent")), false);
  assert.equal(ft2.remaining(req("agent")), 0);
  for (const k of ft2._store.keys()) assert.match(k, /^[0-9a-f]{64}$/);
  const t2 = createTreasury({ db });
  const s = t2.summary();
  assert.equal(s.sales, 1);
  assert.equal(s.netUsdc, "0.03");
  assert.equal(s.killed, true);
  db.close();
});

test("idempotency TTL and pending claims persist and expire", () => {
  const path = tmp();
  let now = 1_000_000;
  let db = openDb(path);
  const idem = createIdempotencyStore({ db, now: () => now, ttlMs: 1000 });
  assert.equal(idem.claim("p"), true);
  db.close();
  db = openDb(path);
  const again = createIdempotencyStore({ db, now: () => now, ttlMs: 1000 });
  assert.equal(again.check("p").status, 409);
  assert.equal(again.claim("p"), false);
  again.release("p");
  assert.equal(again.claim("p"), true);
  now += 5000;
  assert.equal(again.check("p"), null);
  db.close();
});

// ---- races -----------------------------------------------------------------

test("race: 8 processes claim the same idempotency key, exactly one wins", async () => {
  const path = tmp();
  openDb(path).close();
  const code = `import { openDb } from "${SRC}db.js"; import { createIdempotencyStore } from "${SRC}idempotency.js";
    const db = openDb(process.env.DB, { busyTimeoutMs: 5000 }); const s = createIdempotencyStore({ db });
    const wins = []; for (let i = 0; i < 20; i++) if (s.claim("key-" + i)) wins.push(i);
    console.log(JSON.stringify(wins));`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => child(code, { DB: path })));
  const counts = new Map();
  for (const r of runs) {
    assert.equal(r.code, 0, r.err);
    for (const i of JSON.parse(r.out)) counts.set(i, (counts.get(i) || 0) + 1);
  }
  assert.equal(counts.size, 20);
  for (const [, n] of counts) assert.equal(n, 1);
});

test("race: 8 processes x 10 consumes never exceed the free-tier quota", async () => {
  const path = tmp();
  openDb(path).close();
  const code = `import { openDb } from "${SRC}db.js"; import { createFreeTier } from "${SRC}freeTier.js";
    const db = openDb(process.env.DB, { busyTimeoutMs: 5000 }); const ft = createFreeTier({ perDay: 5, db });
    const r = { get: (h) => (h === "x-client-id" ? "shared" : null), ip: "x" };
    let ok = 0; for (let i = 0; i < 10; i++) if (ft.tryConsume(r)) ok++; console.log(ok);`;
  const runs = await Promise.all(Array.from({ length: 8 }, () => child(code, { DB: path })));
  const total = runs.reduce((a, r) => (assert.equal(r.code, 0, r.err), a + Number(r.out)), 0);
  assert.equal(total, 5);
});

test("race: 6 processes record sales concurrently, no lost update", async () => {
  const path = tmp();
  openDb(path).close();
  const code = `import { openDb } from "${SRC}db.js"; import { createTreasury } from "${SRC}treasury.js";
    const db = openDb(process.env.DB, { busyTimeoutMs: 5000 }); const t = createTreasury({ db });
    for (let i = 0; i < 25; i++) t.recordSale({ kind: "full", priceAtomic: 50000n, upstreamAtomic: 20000n });`;
  const runs = await Promise.all(Array.from({ length: 6 }, () => child(code, { DB: path })));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const db = openDb(path);
  const s = createTreasury({ db }).summary();
  assert.equal(s.sales, 150);
  assert.equal(s.earnedUsdc, "7.5");
  assert.equal(s.netUsdc, "4.5");
  db.close();
});

// ---- chaos -----------------------------------------------------------------

test("chaos: a crash inside an open write transaction leaves the previous state", async () => {
  const path = tmp();
  const db = openDb(path);
  createTreasury({ db }).recordSale({ kind: "full", priceAtomic: A("0.05"), upstreamAtomic: A("0.02") });
  db.close();
  const code = `import { DatabaseSync } from "node:sqlite"; const d = new DatabaseSync(process.env.DB);
    d.exec("BEGIN IMMEDIATE"); d.prepare("UPDATE treasury SET state = '{\\"broken\\":true}' WHERE id = 1").run();
    d.prepare("INSERT INTO idempotency (key, state, at) VALUES ('half', 'pending', 1)").run();
    process.exit(9);`;
  const r = await child(code, { DB: path });
  assert.equal(r.code, 9);
  const db2 = openDb(path);
  const s = createTreasury({ db: db2 }).summary();
  assert.equal(s.sales, 1);
  assert.equal(createIdempotencyStore({ db: db2 }).check("half"), null);
  db2.close();
});

test("chaos: SIGKILL during a write loop leaves a consistent, readable DB", async () => {
  const path = tmp();
  openDb(path).close();
  const code = `import { openDb } from "${SRC}db.js"; import { createTreasury } from "${SRC}treasury.js";
    const db = openDb(process.env.DB); const t = createTreasury({ db }); console.log("ready");
    for (;;) t.recordSale({ kind: "full", priceAtomic: 50000n, upstreamAtomic: 20000n });`;
  const p = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", code], { env: { ...process.env, DB: path } });
  await new Promise((res) => p.stdout.once("data", res));
  await new Promise((res) => setTimeout(res, 150));
  p.kill("SIGKILL");
  await new Promise((res) => p.on("exit", res));
  const db = openDb(path);
  const s = createTreasury({ db }).summary();
  assert.ok(s.sales > 0);
  assert.equal(A(s.earnedUsdc), BigInt(s.sales) * 50000n);
  assert.equal(A(s.spentUsdc), BigInt(s.sales) * 20000n);
  db.close();
});

test("chaos: a corrupt or truncated DB refuses to open (fail closed)", () => {
  const garbage = tmp();
  writeFileSync(garbage, Buffer.alloc(8192, 0x5a));
  assert.throws(() => openDb(garbage), StoreUnavailableError);

  const good = tmp();
  const db = openDb(good);
  const t = createTreasury({ db });
  for (let i = 0; i < 50; i++) t.recordSale({ kind: "full", priceAtomic: 50000n, upstreamAtomic: 20000n });
  db.raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const bytes = readFileSync(good);
  bytes.write("not a sqlite header", 0); // smash the header
  writeFileSync(good, bytes);
  assert.throws(() => openDb(good), StoreUnavailableError);
});

test("chaos: a locked DB fails closed (no free credit, no claim, no booking) and recovers", () => {
  const path = tmp();
  const db = openDb(path, { busyTimeoutMs: 50 });
  const idem = createIdempotencyStore({ db });
  const ft = createFreeTier({ perDay: 5, db });
  const t = createTreasury({ db });
  const locker = new DatabaseSync(path);
  locker.exec("BEGIN EXCLUSIVE");
  try {
    assert.throws(() => idem.claim("k"), StoreUnavailableError);
    assert.equal(ft.tryConsume(req("a")), false);
    assert.throws(() => t.recordSale({ kind: "full", priceAtomic: 1n, upstreamAtomic: 0n }), StoreUnavailableError);
    assert.throws(() => t.checkSale("full"), StoreUnavailableError);
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
  }
  assert.equal(idem.claim("k"), true);
  assert.equal(ft.tryConsume(req("a")), true);
  assert.equal(t.summary().sales, 0);
  db.close();
});
