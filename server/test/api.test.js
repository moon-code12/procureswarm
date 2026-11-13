import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Offline and free: no AI key, no NEAR account, a throwaway history folder.
const dir = await mkdtemp(path.join(tmpdir(), "ps-api-"));
process.env.DATA_DIR = dir;
process.env.ANTHROPIC_API_KEY = "";
process.env.NEAR_PRIVATE_KEY = "";
process.env.MAX_AUCTIONS_PER_IP_PER_HOUR = "100";

const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise(r => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("health reports mode, limits and usage", async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.ok, true);
  assert.equal(h.agents, "simulated");
  assert.equal(h.near, "not-configured");
  assert.equal(typeof h.limits.perDay, "number");
  assert.equal(h.usage.calls, 0);
});

test("invalid requests get a clear 400", async () => {
  for (const body of [{ quantity: 0 }, { quantity: 1.5 }, { targetUnitPrice: -1 }, { product: "<b>x</b>" }, "not json"]) {
    const res = await post("/api/auction", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
});

test("browsers from untrusted origins are refused, local ones are allowed", async () => {
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: "http://localhost:5174" } })).status, 200);
});

test("POST /api/auction returns a saved, complete result", async () => {
  const res = await post("/api/auction", { quantity: 50, targetUnitPrice: 40000, rounds: 1 });
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.quantity, 50);
  assert.equal(a.roundsRun, 1);
  assert.equal(a.onChain.status, "not-configured");
  assert.equal(a.requesterVerified, false);

  const detail = await fetch(`${base}/api/auctions/${a.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).id, a.id);
});

test("a self-declared requester is labelled unverified; a fake token does not verify it", async () => {
  const a = await (await post("/api/auction", { requester: "someone.testnet" }, { Authorization: "Bearer fake.token" })).json();
  assert.equal(a.requester, "someone.testnet");
  assert.equal(a.requesterVerified, false);
});

test("the streaming endpoint sends progress events and then the result", async () => {
  const res = await post("/api/auction/stream", { quantity: 100, rounds: 2 });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  const events = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1).type, "result");
  assert.ok(events.filter(e => e.type === "agent").length >= 11);
});

test("history lists saved auctions, newest first", async () => {
  const list = await (await fetch(`${base}/api/auctions`)).json();
  assert.ok(list.length >= 3);
  assert.ok(new Date(list[0].createdAt) >= new Date(list.at(-1).createdAt));
  assert.equal((await fetch(`${base}/api/auctions/nope`)).status, 404);
});

test("verify and on-chain reads say NEAR is not configured instead of failing", async () => {
  assert.equal((await post("/api/verify", { auction: {}, txHash: "x" })).status, 503);
  assert.equal((await fetch(`${base}/api/onchain/anything`)).status, 503);
});

test("sign-in: a challenge can be fetched, and a bad login is a 401 (never a crash)", async () => {
  const c = await (await fetch(`${base}/api/auth/challenge`)).json();
  assert.ok(c.nonce);
  const res = await post("/api/auth/login", { accountId: "alice.testnet", publicKey: "ed25519:abc", signature: "AAAA", nonce: c.nonce });
  assert.equal(res.status, 401);
  assert.equal((await post("/api/auth/login", "not json")).status, 400);
});
