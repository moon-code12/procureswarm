import test from "node:test";
import assert from "node:assert/strict";

// No API key: every agent falls back to its simulated value, so these tests are free and offline.
process.env.ANTHROPIC_API_KEY = "";
const { runAuction } = await import("../src/engine.js");
const { hashAuction } = await import("../src/near.js");

const request = { quantity: 100, targetUnitPrice: 42000, product: "50kg bags of rice", rounds: 2 };

test("a simulated auction is internally consistent", async () => {
  const a = await runAuction(request);
  assert.equal(a.bids.length, 5);
  assert.equal(a.allocations.length, 5);
  assert.equal(a.roundsRun, 2);
  assert.equal(a.rounds.length, 2);
  assert.ok(a.bids.some(b => b.id === a.winningBid.id), "winner is one of the bids");
  assert.equal(a.winningBid.totalPrice, a.winningBid.unitPrice * request.quantity);
  assert.equal(a.auctioneer.source, "simulated");
  for (const b of a.bids) {
    assert.equal(b.source, "simulated");
    assert.ok(b.firstRoundUnitPrice > 0);
  }
});

test("the cost split adds up to the winning total (within rounding)", async () => {
  const a = await runAuction(request);
  const sum = a.allocations.reduce((s, x) => s + x.amount, 0);
  assert.ok(Math.abs(sum - a.winningBid.totalPrice) <= a.allocations.length, `split ${sum} vs total ${a.winningBid.totalPrice}`);
  assert.equal(a.allocations.reduce((s, x) => s + x.quantity, 0), 100);
});

test("auction IDs are unique even when created in the same millisecond", async () => {
  const ids = (await Promise.all(Array.from({ length: 20 }, () => runAuction(request)))).map(a => a.id);
  assert.equal(new Set(ids).size, 20);
  for (const id of ids) assert.ok(id.length <= 64, "fits the contract's request_id limit");
});

test("progress events arrive in a sensible order", async () => {
  const events = [];
  await runAuction(request, { onEvent: e => events.push(e) });
  assert.equal(events[0].type, "start");
  assert.equal(events.filter(e => e.type === "agent" && e.role === "buyer").length, 5);
  assert.equal(events.filter(e => e.type === "agent" && e.role === "seller").length, 10); // 5 sellers x 2 rounds
  assert.equal(events.filter(e => e.type === "round").length, 1);
  assert.equal(events.at(-1).role, "auctioneer");
});

test("a throwing progress listener cannot break the auction", async () => {
  const a = await runAuction(request, { onEvent: () => { throw new Error("listener bug"); } });
  assert.equal(a.status, "completed");
});

test("a single round has no round-2 event", async () => {
  const events = [];
  const a = await runAuction({ ...request, rounds: 1 }, { onEvent: e => events.push(e) });
  assert.equal(a.roundsRun, 1);
  assert.equal(events.filter(e => e.type === "round").length, 0);
});

test("the result hash is stable and detects any change", async () => {
  const a = await runAuction(request);
  const h = hashAuction(a);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(hashAuction(structuredClone(a)), h);

  const changedTotal = structuredClone(a); changedTotal.winningBid.totalPrice += 1;
  const changedWinner = structuredClone(a); changedWinner.winningBid.id = "seller-x";
  const changedSplit = structuredClone(a); changedSplit.allocations[0].amount += 1;
  const changedBid = structuredClone(a); changedBid.bids[0].unitPrice += 1;
  for (const tampered of [changedTotal, changedWinner, changedSplit, changedBid]) {
    assert.notEqual(hashAuction(tampered), h);
  }
});
