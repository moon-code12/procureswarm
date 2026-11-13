import test from "node:test";
import assert from "node:assert/strict";
import { auctionToCsv } from "../src/csv.js";

const auction = (overrides = {}) => ({
  id: "auction-1", createdAt: "2026-11-12T10:00:00.000Z", product: "50kg bags of rice", quantity: 100,
  targetUnitPrice: 42000, roundsRun: 2, savings: 50000,
  winningBid: { name: "Riverbend Supplies", totalPrice: 4150000 },
  onChain: { status: "confirmed", txHash: "abc123" },
  bids: [{ name: "Riverbend Supplies", location: "Ilorin", firstRoundUnitPrice: 42000, unitPrice: 41500, totalPrice: 4150000, deliveryDays: 2, reliability: 96, score: 77, source: "ai-agent" }],
  allocations: [{ name: "Amina Foods", quantity: 25, sharePercent: 25, amount: 1037500, source: "ai-agent" }],
  ...overrides
});

test("the CSV contains the summary, the bids and the cost split", () => {
  const csv = auctionToCsv(auction());
  assert.match(csv, /Auction ID,auction-1/);
  assert.match(csv, /Winner,Riverbend Supplies/);
  assert.match(csv, /Riverbend Supplies,Ilorin,42000,41500,4150000,2,96,77,ai-agent/);
  assert.match(csv, /Amina Foods,25,25,1037500,ai-agent/);
  assert.match(csv, /NEAR transaction,abc123/);
});

test("text that spreadsheets would run as a formula is neutralised", () => {
  for (const evil of ["=HYPERLINK(\"http://evil\",\"x\")", "+cmd|' /C calc'!A0", "-2+3", "@SUM(1+1)"]) {
    const csv = auctionToCsv(auction({ product: evil }));
    const line = csv.split("\r\n").find(l => l.startsWith("Product,"));
    assert.ok(/^Product,"?'/.test(line), `not neutralised: ${line}`);
  }
});

test("commas, quotes and line breaks are escaped so columns stay aligned", () => {
  const csv = auctionToCsv(auction({ product: 'Rice, "premium"\nbag' }));
  assert.match(csv, /Product,"Rice, ""premium""\nbag"/);
});

test("plain negative numbers are left alone (only text is guarded)", () => {
  const csv = auctionToCsv(auction({ savings: -5 }));
  assert.match(csv, /Savings vs target \(NGN\),-5\r\n/);
});
