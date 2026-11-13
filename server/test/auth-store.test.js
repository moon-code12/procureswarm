import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "ps-store-"));
process.env.DATA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-for-unit-tests";

const { createChallenge, issueToken, verifyToken, loginWithSignature } = await import("../src/auth.js");
const store = await import("../src/store.js");

test.after(() => rm(dir, { recursive: true, force: true }));

// ---------- auth ----------

test("a freshly issued token verifies to its account", () => {
  assert.equal(verifyToken(issueToken("alice.testnet")), "alice.testnet");
});

test("tokens are rejected when tampered with, malformed, or expired", () => {
  const token = issueToken("alice.testnet", 1_000);
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ a: "admin.testnet", e: 9e15 })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${mac}`), null, "swapped body");
  assert.equal(verifyToken(`${body}.${mac.slice(0, -2)}xx`), null, "altered signature");
  assert.equal(verifyToken("garbage"), null);
  assert.equal(verifyToken(""), null);
  assert.equal(verifyToken(undefined), null);
  assert.equal(verifyToken(token, 1_000 + 13 * 3600_000), null, "expired after 12h");
  assert.equal(verifyToken(token, 2_000), "alice.testnet", "valid just after issue");
});

test("a challenge is a 32-byte one-time nonce", () => {
  const c = createChallenge();
  assert.equal(Buffer.from(c.nonce, "base64").length, 32);
  assert.notEqual(createChallenge().nonce, c.nonce);
  assert.equal(c.recipient, "procureswarm");
});

test("sign-in rejects unknown, replayed, expired and malformed challenges before touching the network", async () => {
  const fakeProvider = {}; // must never be called
  const base = { accountId: "alice.testnet", publicKey: "ed25519:abc", signature: "AAAA" };

  await assert.rejects(loginWithSignature({ ...base, nonce: Buffer.alloc(32).toString("base64") }, fakeProvider), /expired/i);

  const c = createChallenge(1_000);
  await assert.rejects(loginWithSignature({ ...base, nonce: c.nonce }, fakeProvider, 1_000 + 6 * 60_000), /expired/i);
  // the expired challenge was consumed, so it cannot be used again either
  await assert.rejects(loginWithSignature({ ...base, nonce: c.nonce }, fakeProvider, 1_500), /expired/i);

  await assert.rejects(loginWithSignature({ ...base, accountId: "Bad Account!", nonce: createChallenge().nonce }, fakeProvider), /invalid account/i);
  await assert.rejects(loginWithSignature({ accountId: "alice.testnet" }, fakeProvider), /invalid sign-in data/i);
});

test("a challenge is consumed even when the signature check fails (no retries on one nonce)", async () => {
  const c = createChallenge();
  await assert.rejects(loginWithSignature({ accountId: "alice.testnet", publicKey: "ed25519:11111111111111111111111111111111", signature: "AAAA", nonce: c.nonce }, {}));
  await assert.rejects(loginWithSignature({ accountId: "alice.testnet", publicKey: "ed25519:abc", signature: "AAAA", nonce: c.nonce }, {}), /expired/i);
});

// ---------- history store ----------

const sample = (id, createdAt = new Date().toISOString()) => ({
  id, createdAt, product: "rice", quantity: 100,
  winningBid: { id: "seller-river", name: "Riverbend", totalPrice: 4_000_000, formattedTotal: "₦4,000,000" },
  bids: [{ source: "ai-agent" }], allocations: [{ source: "simulated" }], auctioneer: { source: "ai-agent" },
  savings: 200_000, roundsRun: 2, onChain: { status: "confirmed", txHash: "abc" }
});

test("saved auctions are listed newest first, with summaries, and can be fetched whole", async () => {
  await store.saveAuction(sample("auction-1"));
  await store.saveAuction(sample("auction-2"));
  const list = await store.listAuctions();
  assert.deepEqual(list.map(x => x.id), ["auction-2", "auction-1"]);
  assert.equal(list[0].aiAgents, 2); // one AI bid + the AI auctioneer
  assert.equal(list[0].onChainStatus, "confirmed");
  assert.equal((await store.getAuction("auction-1")).winningBid.name, "Riverbend");
  assert.equal(await store.getAuction("missing"), null);
});

test("history survives a restart (it is read back from disk)", async () => {
  store.resetStoreForTests();
  const list = await store.listAuctions();
  assert.equal(list.length, 2);
  const onDisk = JSON.parse(await readFile(path.join(dir, "auctions.json"), "utf8"));
  assert.equal(onDisk.length, 2);
});

test("countSince only counts recent auctions (this drives the daily budget)", async () => {
  await store.saveAuction(sample("old", new Date(Date.now() - 2 * 24 * 3600_000).toISOString()));
  assert.equal(await store.countSince(24 * 3600_000), 2);
  assert.equal(await store.countSince(3 * 24 * 3600_000), 3);
});

test("history is capped at 200 entries", async () => {
  for (let i = 0; i < 205; i++) await store.saveAuction(sample(`bulk-${i}`));
  assert.equal((await store.listAuctions(500)).length, 200);
});

test("a corrupt history file does not crash the server", async () => {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(dir, "auctions.json"), "{not json");
  store.resetStoreForTests();
  assert.deepEqual(await store.listAuctions(), []);
});
