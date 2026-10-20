// ed25519 receipt signing for Gatecheck verdicts.
// - Keypair generated on first boot and persisted to data/gatecheck-ed25519.json
//   (or loaded from GATECHECK_SIGNING_KEY). node:crypto only, no dependencies.
// - Receipts are canonical-JSON signed; the public key is served at
//   /.well-known/gatecheck-keys.json so anyone can verify.
// - Every receipt is appended to data/receipts.jsonl (append-only log).

import { createHash, generateKeyPairSync, sign, verify, createPublicKey } from "node:crypto";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { config } from "./config.js";

/** Deterministic canonical JSON: sorted keys, no whitespace. */
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`).join(",")}}`;
}

let keypair = null;

async function dataPath(name) {
  const dir = new URL(config.dataDir);
  await mkdir(dir, { recursive: true });
  return new URL(name, dir);
}

export async function loadKeys() {
  if (keypair) return keypair;
  // 1. Explicit env key wins (32-byte raw ed25519 seed, base64).
  if (config.signingKeyB64) {
    const priv = Buffer.from(config.signingKeyB64, "base64");
    if (priv.length !== 32) throw new Error("GATECHECK_SIGNING_KEY must be 32 bytes, base64");
    const { createPrivateKey } = await import("node:crypto");
    const pk = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), priv]), format: "der", type: "pkcs8" });
    keypair = { privateKey: pk, publicKeyJwk: null };
    const pub = createPublicKey(pk);
    keypair.publicKeyJwk = pub.export({ format: "jwk" });
    return keypair;
  }
  // 2. Persisted keypair.
  const path = await dataPath("gatecheck-ed25519.json");
  try {
    const saved = JSON.parse(await readFile(path, "utf8"));
    const { createPrivateKey } = await import("node:crypto");
    const pk = createPrivateKey({ key: Buffer.from(saved.pkcs8der, "base64"), format: "der", type: "pkcs8" });
    keypair = { privateKey: pk, publicKeyJwk: saved.jwk };
    return keypair;
  } catch { /* generate fresh below */ }
  // 3. Generate + persist.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  await writeFile(path, JSON.stringify({ jwk, pkcs8der: der }, null, 2), { mode: 0o600 });
  console.log("[gatecheck] generated new ed25519 receipt keypair at data/gatecheck-ed25519.json");
  keypair = { privateKey, publicKeyJwk: jwk };
  return keypair;
}

export function signReceipt(unsigned) {
  if (!keypair) throw new Error("keys not loaded — call loadKeys() at boot");
  const payload = canonicalize(unsigned);
  const signature = sign(null, Buffer.from(payload), keypair.privateKey).toString("base64");
  return { ...unsigned, signature };
}

export function verifyReceipt(receipt, jwk = keypair?.publicKeyJwk) {
  const { signature, ...unsigned } = receipt;
  const pub = createPublicKey({ key: jwk, format: "jwk" });
  return verify(null, Buffer.from(canonicalize(unsigned)), pub, Buffer.from(signature, "base64"));
}

export function keysDocument() {
  if (!keypair?.publicKeyJwk) throw new Error("keys not loaded");
  return {
    keys: [{ ...keypair.publicKeyJwk, kid: "gatecheck-1", use: "sig", alg: "EdDSA" }],
    keys_url: "https://gatecheck.402xagent.com/.well-known/gatecheck-keys.json",
    note: "Update keys_url to the production host on deploy.",
  };
}

export async function logReceipt(receipt) {
  const path = await dataPath("receipts.jsonl");
  await appendFile(path, canonicalize(receipt) + "\n");
}

export function receiptId() {
  return `gc_${Date.now().toString(36)}_${createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 8)}`;
}
