import express from "express";
import cors from "cors";
import { runAuction } from "./engine.js";
import { agentsEnabled, usage } from "./agents.js";
import { nearEnabled, recordAuctionOnChain, getOnChainRecord, verifyAuctionOnChain, nearProvider } from "./near.js";
import { limitConfig, parseAuctionRequest, reserveAuction, lightLimit, originAllowed } from "./limits.js";
import { saveAuction, listAuctions, getAuction, countSince } from "./store.js";
import { createChallenge, loginWithSignature, verifyToken } from "./auth.js";

const DAY = 24 * 3600_000;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;

export const app = express();
app.disable("x-powered-by");

// Browsers from other origins are refused; see ALLOWED_ORIGINS in .env.example.
app.use((req, res, next) => {
  if (!originAllowed(req.headers.origin)) return res.status(403).json({ error: "Origin not allowed" });
  next();
});
app.use(cors());
app.use(express.json({ limit: "200kb" }));
app.use((err, _req, res, next) => {
  if (err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
    return res.status(400).json({ error: "Invalid request body" });
  }
  next(err);
});

const bearerAccount = req => verifyToken((req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
const tooMany = (res, what) => res.status(429).json({ error: `Too many ${what} requests. Please slow down.` });

app.get("/api/health", async (_req, res) => {
  const cfg = limitConfig();
  res.json({
    ok: true,
    agents: agentsEnabled() ? "ai-agent" : "simulated",
    near: nearEnabled() ? "testnet" : "not-configured",
    contractId: nearEnabled() ? process.env.NEAR_CONTRACT_ID : null,
    limits: { ...cfg, startedToday: await countSince(DAY) },
    usage // AI calls and tokens since the server started
  });
});

// ---------- running an auction ----------

function startStream(res) {
  res.status(200).set({
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no"
  });
  res.flushHeaders();
  return event => { if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`); };
}

async function handleAuction(req, res, stream) {
  const parsed = parseAuctionRequest(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const slot = reserveAuction(req.ip, await countSince(DAY));
  if (!slot.ok) {
    res.set("Retry-After", String(slot.retryAfter));
    return res.status(slot.status).json({ error: slot.error });
  }

  // A signed-in (verified) account is trusted; a plain "requester" field is only a self-declared label.
  const verified = bearerAccount(req);
  const declared = typeof req.body?.requester === "string" && ACCOUNT_RE.test(req.body.requester) ? req.body.requester : null;

  const send = stream ? startStream(res) : () => {};
  try {
    const auction = await runAuction(parsed.value, { onEvent: send });
    auction.requester = verified ?? declared;
    auction.requesterVerified = Boolean(verified);

    // onChain.status is "confirmed" only after a FINAL, successful NEAR testnet transaction.
    if (!nearEnabled()) {
      auction.onChain = { status: "not-configured" };
    } else {
      send({ type: "chain", status: "recording" });
      try {
        auction.onChain = { status: "confirmed", ...(await recordAuctionOnChain(auction)) };
      } catch (err) {
        console.error("NEAR recording failed:", err.message);
        auction.onChain = { status: "failed", error: "Could not record this auction on NEAR testnet" };
      }
    }

    await saveAuction(auction);
    if (stream) { send({ type: "result", auction }); res.end(); } else res.json(auction);
  } catch (err) {
    console.error("Auction failed:", err);
    if (stream) { send({ type: "error", message: "Auction failed" }); res.end(); }
    else res.status(500).json({ error: "Auction failed" });
  } finally {
    slot.release();
  }
}

app.post("/api/auction", (req, res) => handleAuction(req, res, false));
app.post("/api/auction/stream", (req, res) => handleAuction(req, res, true));

// ---------- history ----------

app.get("/api/auctions", async (req, res) => {
  if (!lightLimit(req.ip, 60)) return tooMany(res, "history");
  res.json(await listAuctions(50));
});

app.get("/api/auctions/:id", async (req, res) => {
  if (!lightLimit(req.ip, 60)) return tooMany(res, "history");
  const auction = await getAuction(req.params.id);
  if (!auction) return res.status(404).json({ error: "Auction not found" });
  res.json(auction);
});

// ---------- sign in with NEAR (proves wallet ownership; sends no transaction) ----------

app.get("/api/auth/challenge", (req, res) => {
  if (!lightLimit(`auth:${req.ip}`, 20)) return tooMany(res, "sign-in");
  try {
    res.json(createChallenge());
  } catch {
    res.status(503).json({ error: "Sign-in is busy. Try again shortly." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  if (!lightLimit(`login:${req.ip}`, 10)) return tooMany(res, "sign-in");
  try {
    res.json(await loginWithSignature(req.body || {}, nearProvider()));
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// ---------- verification ----------

// Independently verify that an auction result was recorded on NEAR testnet.
app.post("/api/verify", async (req, res) => {
  if (!lightLimit(`verify:${req.ip}`, 30)) return tooMany(res, "verification");
  if (!nearEnabled()) return res.status(503).json({ error: "NEAR not configured" });
  const { auction, txHash } = req.body || {};
  if (!auction || typeof auction !== "object") return res.status(400).json({ error: "auction is required" });
  try {
    res.json(await verifyAuctionOnChain(auction, txHash));
  } catch (err) {
    console.error("Verification error:", err.message);
    res.status(502).json({ error: "Could not verify against NEAR testnet" });
  }
});

// Read a record back from the contract to verify what is actually stored on-chain.
app.get("/api/onchain/:requestId", async (req, res) => {
  if (!lightLimit(`onchain:${req.ip}`, 30)) return tooMany(res, "on-chain");
  if (!nearEnabled()) return res.status(503).json({ error: "NEAR not configured" });
  try {
    const record = await getOnChainRecord(req.params.requestId);
    if (!record) return res.status(404).json({ error: "No on-chain record for this request" });
    res.json(record);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not read from NEAR testnet" });
  }
});

// Start listening only when run directly (tests import `app` without opening a port).
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const port = process.env.PORT || 6000;
  app.listen(port, () => {
    const cfg = limitConfig();
    console.log(`ProcureSwarm server on :${port} (agents: ${agentsEnabled() ? "AI" : "simulated"}, NEAR: ${nearEnabled() ? "testnet" : "off"})`);
    console.log(`Limits: ${cfg.perIpPerHour}/hour per client, ${cfg.perDay}/day total, ${cfg.maxConcurrent} at once, up to ${cfg.maxRounds} rounds`);
  });
}
