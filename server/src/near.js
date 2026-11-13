import { createHash } from "node:crypto";
import { Account, JsonRpcProvider } from "near-api-js";

const NETWORK = "testnet";
const RPC_URL = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const EXPLORER = "https://testnet.nearblocks.io";

/** On-chain recording is only attempted when the signer account, key and contract are all configured. */
export const nearEnabled = () =>
  Boolean(process.env.NEAR_ACCOUNT_ID && process.env.NEAR_PRIVATE_KEY && process.env.NEAR_CONTRACT_ID);

let provider;
let account;
const getProvider = () => (provider ??= new JsonRpcProvider({ url: RPC_URL }));
// The private key lives only on the backend, loaded from the environment. It is never sent to the client.
const getAccount = () =>
  (account ??= new Account(process.env.NEAR_ACCOUNT_ID, getProvider(), process.env.NEAR_PRIVATE_KEY));

/** Deterministic SHA-256 of the full auction result. The result itself stays off-chain. */
export function hashAuction(auction) {
  const canonical = JSON.stringify({
    id: auction.id,
    product: auction.product,
    quantity: auction.quantity,
    bids: auction.bids.map(b => [b.id, b.unitPrice, b.deliveryDays]),
    winner: auction.winningBid.id,
    total: auction.winningBid.totalPrice,
    allocations: auction.allocations.map(a => [a.id, a.quantity, a.amount]),
    createdAt: auction.createdAt
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The exact preimage sellers commit to before revealing a bid on-chain. */
export function hashBid(auctionId, sellerId, unitPrice, quantity, salt) {
  return createHash('sha256')
    .update(`${auctionId}|${sellerId}|${unitPrice}|${quantity}|${salt}`)
    .digest('hex')
}

export async function commitBid(auctionId, commitment) {
  return getAccount().callFunctionRaw({
    contractId: process.env.NEAR_CONTRACT_ID,
    methodName: 'commit_bid',
    args: { auction_id: auctionId, commitment },
    waitUntil: 'FINAL'
  })
}

export async function revealBid(auctionId, unitPrice, quantity, salt) {
  return getAccount().callFunctionRaw({
    contractId: process.env.NEAR_CONTRACT_ID,
    methodName: 'reveal_bid',
    args: { auction_id: auctionId, unit_price: unitPrice, quantity, salt },
    waitUntil: 'FINAL'
  })
}

export async function depositEscrow(auctionId, amountYocto) {
  return getAccount().callFunctionRaw({
    contractId: process.env.NEAR_CONTRACT_ID,
    methodName: 'deposit_escrow',
    args: { auction_id: auctionId },
    deposit: String(amountYocto),
    waitUntil: 'FINAL'
  })
}

export async function confirmDelivery(auctionId, sellerId) {
  return getAccount().callFunctionRaw({
    contractId: process.env.NEAR_CONTRACT_ID,
    methodName: 'confirm_delivery',
    args: { auction_id: auctionId, seller_id: sellerId },
    waitUntil: 'FINAL'
  })
}

export async function refundEscrow(auctionId) {
  return getAccount().callFunctionRaw({
    contractId: process.env.NEAR_CONTRACT_ID,
    methodName: 'refund_escrow',
    args: { auction_id: auctionId },
    waitUntil: 'FINAL'
  })
}

/**
 * Record an auction result on NEAR testnet. Returns a result object only after the transaction
 * has reached FINAL status and succeeded; otherwise throws. Callers must never present a
 * transaction hash or explorer link unless this returned successfully.
 */
export async function recordAuctionOnChain(auction) {
  const contractId = process.env.NEAR_CONTRACT_ID;
  const requestHash = hashAuction(auction);

  const outcome = await getAccount().callFunctionRaw({
    contractId,
    methodName: "record_auction",
    args: {
      request_id: auction.id,
      request_hash: requestHash,
      winner_id: auction.winningBid.id,
      total_amount: auction.winningBid.totalPrice
    },
    waitUntil: "FINAL"
  });

  const failure = outcome.status && typeof outcome.status === "object" && outcome.status.Failure;
  if (failure) throw new Error(`NEAR transaction failed: ${JSON.stringify(failure)}`);

  const txHash = outcome.transaction?.hash;
  if (!txHash) throw new Error("NEAR transaction returned no hash");

  return {
    network: NETWORK,
    contractId,
    requestHash,
    txHash,
    finality: outcome.final_execution_status,
    explorerUrl: `${EXPLORER}/txns/${txHash}`
  };
}

/** Read a record back from the contract, to verify what was actually stored. */
export async function getOnChainRecord(requestId) {
  return (
    (await getProvider().callFunction({
      contractId: process.env.NEAR_CONTRACT_ID,
      method: "get_record",
      args: { request_id: requestId }
    })) ?? null
  );
}

const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * Independently verifies that an auction result was recorded on NEAR testnet. Nothing the caller
 * says about the chain is trusted: the hash is recomputed from the auction data, and the transaction
 * and the contract state are both read fresh from the network and compared with it.
 * Returns { verified, checks: [{ name, passed, detail }], ... }.
 */
export async function verifyAuctionOnChain(auction, txHash) {
  const checks = [];
  const add = (name, passed, detail = "") => checks.push({ name, passed: Boolean(passed), detail });
  const finish = extra => ({ verified: checks.length > 0 && checks.every(c => c.passed), checks, ...extra });

  if (typeof txHash !== "string" || !TX_HASH_RE.test(txHash)) {
    add("Transaction hash is well-formed", false, "Expected a 43-44 character base58 hash");
    return finish({});
  }

  let recomputed;
  try {
    recomputed = hashAuction(auction);
    add("Result hash recomputed from the auction data", true, recomputed);
  } catch {
    add("Result hash recomputed from the auction data", false, "Auction data is incomplete or malformed");
    return finish({});
  }

  const contractId = process.env.NEAR_CONTRACT_ID;
  let tx;
  try {
    tx = await getProvider().viewTransactionStatus({
      txHash,
      accountId: process.env.NEAR_ACCOUNT_ID,
      waitUntil: "FINAL"
    });
    add("Transaction found on NEAR testnet", true);
  } catch {
    add("Transaction found on NEAR testnet", false, "The network has no such transaction for the backend account");
    return finish({ recomputedHash: recomputed });
  }

  const failed = tx.status && typeof tx.status === "object" && "Failure" in tx.status;
  add("Transaction succeeded and is final", tx.final_execution_status === "FINAL" && !failed,
    `status ${tx.final_execution_status}${failed ? ", execution failed" : ""}`);

  const actions = tx.transaction?.actions ?? [];
  const call = actions.length === 1 ? actions[0].FunctionCall : undefined;
  add("Sent to the registry contract, calling record_auction",
    tx.transaction?.receiver_id === contractId && call?.method_name === "record_auction",
    `receiver ${tx.transaction?.receiver_id}`);

  let args = {};
  try {
    args = JSON.parse(Buffer.from(call?.args ?? "", "base64").toString("utf8"));
  } catch { /* leaves args empty; the comparisons below will fail */ }

  add("Transaction request_id matches this auction", args.request_id === auction.id);
  add("Transaction hash matches the recomputed hash", args.request_hash === recomputed);
  add("Transaction winner and total match this auction",
    args.winner_id === auction.winningBid.id && args.total_amount === auction.winningBid.totalPrice);

  try {
    const stored = await getOnChainRecord(auction.id);
    add("Contract's stored record matches this auction",
      stored?.request_hash === recomputed &&
        stored?.winner_id === auction.winningBid.id &&
        stored?.total_amount === auction.winningBid.totalPrice,
      stored ? "record found" : "no record in the contract");
  } catch {
    add("Contract's stored record matches this auction", false, "Could not read the contract");
  }

  return finish({ recomputedHash: recomputed, txHash, explorerUrl: `${EXPLORER}/txns/${txHash}` });
}

/** The shared RPC provider (also used to check wallet sign-ins). Works without any NEAR account configured. */
export const nearProvider = () => getProvider();
