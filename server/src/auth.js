// "Sign in with NEAR": the user proves they control a NEAR account by signing a one-time message
// (NEP-413) with their wallet. This sends no transaction and costs nothing. A verified login gives a
// short-lived signed token that marks auctions as requested by that verified account.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "near-api-js/nep413";

const RECIPIENT = "procureswarm";
const MESSAGE = "Sign in to ProcureSwarm. This proves you control this NEAR account. It costs nothing and sends no transaction.";
const CHALLENGE_TTL_MS = 5 * 60_000;
const TOKEN_TTL_MS = 12 * 3600_000;
const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;

let fallbackSecret;
// Set SESSION_SECRET to keep logins valid across restarts. Without it, a random secret is used
// and everyone simply signs in again after a restart.
const secret = () => process.env.SESSION_SECRET || (fallbackSecret ??= randomBytes(32).toString("hex"));

const challenges = new Map(); // nonce (base64) -> expiry time

function prune(now) {
  for (const [nonce, exp] of challenges) if (exp < now) challenges.delete(nonce);
}

/** Step 1: hand the client a fresh one-time challenge to sign. */
export function createChallenge(now = Date.now()) {
  prune(now);
  if (challenges.size > 5000) throw new Error("Too many pending sign-ins");
  const nonce = randomBytes(32).toString("base64");
  challenges.set(nonce, now + CHALLENGE_TTL_MS);
  return { nonce, message: MESSAGE, recipient: RECIPIENT };
}

const sign = payload => createHmac("sha256", secret()).update(payload).digest("base64url");

export function issueToken(accountId, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ a: accountId, e: now + TOKEN_TTL_MS })).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Returns the account ID for a valid, unexpired token; otherwise null. */
export function verifyToken(token, now = Date.now()) {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof a === "string" && e > now ? a : null;
  } catch {
    return null;
  }
}

/**
 * Step 2: check a signed challenge. `provider` is used to confirm that the signing key really belongs
 * to the claimed account (verifyMessage rejects a valid signature from a key the account doesn't hold).
 * Returns { accountId, token } or throws an Error with a user-safe message.
 */
export async function loginWithSignature({ accountId, publicKey, signature, nonce }, provider, now = Date.now()) {
  if (typeof accountId !== "string" || !ACCOUNT_RE.test(accountId)) throw new Error("Invalid account");
  if (typeof publicKey !== "string" || typeof signature !== "string" || typeof nonce !== "string") throw new Error("Invalid sign-in data");

  // One-time: the challenge is consumed before anything else, so it can never be replayed.
  const exp = challenges.get(nonce);
  challenges.delete(nonce);
  if (!exp || exp < now) throw new Error("The sign-in request expired. Please try again.");

  const nonceBytes = Buffer.from(nonce, "base64");
  if (nonceBytes.length !== 32) throw new Error("Invalid sign-in data");

  try {
    await verifyMessage({
      signerAccountId: accountId,
      signerPublicKey: publicKey,
      payload: { message: MESSAGE, recipient: RECIPIENT, nonce: new Uint8Array(nonceBytes) },
      signature: new Uint8Array(Buffer.from(signature, "base64")),
      provider
    });
  } catch {
    throw new Error("Signature could not be verified for this account");
  }
  return { accountId, token: issueToken(accountId, now) };
}

export const _test = { challenges };
