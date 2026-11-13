// Auction history, kept in a JSON file so it survives restarts. Small and simple on purpose:
// it keeps the latest 200 auctions. The daily auction budget is also read from here.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_KEPT = 200;
const dir = () => process.env.DATA_DIR || fileURLToPath(new URL("../data/", import.meta.url));
const file = () => path.join(dir(), "auctions.json");

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8"));
    cache = Array.isArray(parsed) ? parsed : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist() {
  await mkdir(dir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  await writeFile(tmp, JSON.stringify(cache));
  await rename(tmp, file()); // atomic replace, so a crash never leaves a half-written file
}

export async function saveAuction(auction) {
  await load();
  cache.unshift(auction);
  if (cache.length > MAX_KEPT) cache.length = MAX_KEPT;
  writeQueue = writeQueue.then(persist, persist);
  await writeQueue;
}

/** Newest first, without the bulky per-agent detail. */
export async function listAuctions(limit = 50) {
  const all = await load();
  return all.slice(0, limit).map(a => ({
    id: a.id,
    createdAt: a.createdAt,
    product: a.product,
    quantity: a.quantity,
    winnerName: a.winningBid?.name,
    winnerId: a.winningBid?.id,
    totalPrice: a.winningBid?.totalPrice,
    formattedTotal: a.winningBid?.formattedTotal,
    savings: a.savings,
    roundsRun: a.roundsRun ?? 1,
    onChainStatus: a.onChain?.status ?? "not-configured",
    txHash: a.onChain?.txHash ?? null,
    aiAgents: [...(a.bids ?? []), ...(a.allocations ?? [])].filter(x => x.source === "ai-agent").length + (a.auctioneer?.source === "ai-agent" ? 1 : 0)
  }));
}

export async function getAuction(id) {
  const all = await load();
  return all.find(a => a.id === id) ?? null;
}

/** How many auctions started in the last `ms` milliseconds. */
export async function countSince(ms, now = Date.now()) {
  const all = await load();
  return all.filter(a => now - new Date(a.createdAt).getTime() < ms).length;
}

export function resetStoreForTests() {
  cache = null;
  writeQueue = Promise.resolve();
}
