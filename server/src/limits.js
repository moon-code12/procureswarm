// Protection for the paid parts of the server (AI calls and NEAR transactions):
// input validation, per-client rate limits, a daily auction budget, a concurrency cap, and CORS.

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Read each time so tests and .env changes are picked up. */
export const limitConfig = () => ({
  perIpPerHour: num(process.env.MAX_AUCTIONS_PER_IP_PER_HOUR, 6),
  perDay: num(process.env.MAX_AUCTIONS_PER_DAY, 40),
  maxConcurrent: num(process.env.MAX_CONCURRENT_AUCTIONS, 2),
  maxRounds: Math.min(3, Math.round(num(process.env.MAX_ROUNDS, 2)))
});

// ---------- input validation ----------

/** Validates an auction request body. Returns { value } or { error }. */
export function parseAuctionRequest(body, cfg = limitConfig()) {
  const b = body && typeof body === "object" ? body : {};

  const quantity = b.quantity === undefined ? 100 : Number(b.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    return { error: "quantity must be a whole number between 1 and 100,000" };
  }

  const targetUnitPrice = b.targetUnitPrice === undefined ? 42000 : Number(b.targetUnitPrice);
  if (!Number.isFinite(targetUnitPrice) || targetUnitPrice < 1 || targetUnitPrice > 10_000_000) {
    return { error: "targetUnitPrice must be between 1 and 10,000,000" };
  }

  // The product text is placed into AI prompts, so keep it short and plain.
  const rawProduct = b.product === undefined ? "50kg bags of rice" : b.product;
  if (typeof rawProduct !== "string") return { error: "product must be text" };
  const product = rawProduct.replace(/\s+/g, " ").trim();
  if (product.length < 2 || product.length > 80) return { error: "product must be 2 to 80 characters" };
  if (!/^[\p{L}\p{N} .,()/'%&+-]+$/u.test(product)) {
    return { error: "product may only contain letters, numbers, spaces and . , ( ) / ' % & + -" };
  }

  const rounds = b.rounds === undefined ? cfg.maxRounds : Number(b.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) return { error: "rounds must be a whole number of at least 1" };

  return { value: { quantity, targetUnitPrice, product, rounds: Math.min(rounds, cfg.maxRounds) } };
}

// ---------- rate limiting ----------

const hits = new Map(); // ip -> [timestamps of started auctions]
let running = 0;

const HOUR = 3600_000;

/**
 * Decide whether a new auction may start. `startedToday` is how many auctions began in the last 24 hours
 * (read from the persistent history, so restarting the server does not reset the daily budget).
 * On success it reserves a slot: call the returned `release()` when the auction ends.
 */
export function reserveAuction(ip, startedToday, now = Date.now()) {
  const cfg = limitConfig();

  if (startedToday >= cfg.perDay) {
    return { ok: false, status: 429, error: `The daily limit of ${cfg.perDay} auctions has been reached. Try again tomorrow.`, retryAfter: 3600 };
  }
  if (running >= cfg.maxConcurrent) {
    return { ok: false, status: 429, error: "The server is busy running other auctions. Please try again in a minute.", retryAfter: 30 };
  }
  const recent = (hits.get(ip) ?? []).filter(t => now - t < HOUR);
  if (recent.length >= cfg.perIpPerHour) {
    const retryAfter = Math.ceil((HOUR - (now - recent[0])) / 1000);
    return { ok: false, status: 429, error: `Limit reached: ${cfg.perIpPerHour} auctions per hour. Try again in ${Math.ceil(retryAfter / 60)} min.`, retryAfter };
  }

  recent.push(now);
  hits.set(ip, recent);
  running += 1;
  let released = false;
  return { ok: true, release: () => { if (!released) { released = true; running -= 1; } } };
}

/** Light limiter for the cheap read/verify endpoints, which still make NEAR RPC calls. */
const lightHits = new Map();
export function lightLimit(ip, max = 60, windowMs = 60_000, now = Date.now()) {
  const recent = (lightHits.get(ip) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= max) return false;
  recent.push(now);
  lightHits.set(ip, recent);
  return true;
}

export function resetLimitsForTests() {
  hits.clear();
  lightHits.clear();
  running = 0;
}

// Drop old entries now and then so the maps cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    const fresh = list.filter(t => now - t < HOUR);
    if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
  }
  for (const [ip, list] of lightHits) {
    const fresh = list.filter(t => now - t < 60_000);
    if (fresh.length) lightHits.set(ip, fresh); else lightHits.delete(ip);
  }
}, 10 * 60_000).unref();

// ---------- CORS ----------

/**
 * Which browser origins may call the API. Set ALLOWED_ORIGINS (comma separated) in production.
 * Without it, only local development origins are allowed: localhost and private network addresses
 * (so you can open the app from your phone on the same Wi-Fi).
 */
export function originAllowed(origin) {
  if (!origin) return true; // same-origin or non-browser clients (curl, the server's own tests)
  const list = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (list.length) return list.includes(origin);
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    return (
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return false;
  }
}
