// Tests the deployed registry contract's rules against NEAR testnet.
// Usage (from /server): npm run test-contract
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from "near-api-js";

const { NEAR_ACCOUNT_ID: owner, NEAR_PRIVATE_KEY: ownerKey, NEAR_CONTRACT_ID: contractId } = process.env;
if (!owner || !ownerKey || !contractId) {
  console.error("Set NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY and NEAR_CONTRACT_ID in server/.env first.");
  process.exit(1);
}

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org" });
const ownerAccount = new Account(owner, provider, ownerKey);

// A throwaway sub-account with no rights on the contract, used as the "attacker".
const attackerId = `attacker-${Date.now()}.${owner}`;
const attackerKey = KeyPair.fromRandom("ed25519");
await ownerAccount.createAccount({
  newAccountId: attackerId,
  publicKey: attackerKey.getPublicKey(),
  nearToTransfer: nearToYocto("0.2")
});
const attacker = new Account(attackerId, provider, attackerKey.toString());

const hash = seed => createHash("sha256").update(seed).digest("hex");
const run = id => Date.now() + "-" + id;

/** Calls record_auction as `account`. Returns { ok, error } where error is the contract's panic text. */
async function record(account, args) {
  try {
    const out = await account.callFunctionRaw({ contractId, methodName: "record_auction", args, waitUntil: "FINAL" });
    const failure = out.status && typeof out.status === "object" && out.status.Failure;
    return failure ? { ok: false, error: JSON.stringify(failure) } : { ok: true };
  } catch (err) {
    return { ok: false, error: `${err.name}: ${err.message ?? err}` };
  }
}

const results = [];
function check(name, passed, detail = "") {
  results.push(passed);
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}
// The contract's panic text does not reach the client (the network reports only a WebAssembly trap),
// so we require a ContractExecutionError. Each bad call differs from the passing owner call (the control)
// in exactly one respect, so a rejection can only be caused by that rule.
const rejected = r => !r.ok && r.error.includes("ContractExecutionError");
const good = { request_hash: hash("a"), winner_id: "seller-river", total_amount: 1000 };

// 1. Owner can record
const id1 = run("ok");
check("owner can record an auction", (await record(ownerAccount, { request_id: id1, ...good })).ok);
const stored = await provider.callFunction({ contractId, method: "get_record", args: { request_id: id1 } });
check("record reads back correctly", stored?.winner_id === "seller-river" && stored?.total_amount === 1000 && stored?.request_hash === good.request_hash);

// 2. Duplicate request_id is rejected and the original is not overwritten
const dup = await record(ownerAccount, { request_id: id1, request_hash: hash("b"), winner_id: "seller-prime", total_amount: 9999 });
check("duplicate request_id is rejected", rejected(dup));
const after = await provider.callFunction({ contractId, method: "get_record", args: { request_id: id1 } });
check("original record is not overwritten", after?.winner_id === "seller-river" && after?.total_amount === 1000);

// 3. Non-owner cannot write
const id3 = run("attacker");
const hack = await record(attacker, { request_id: id3, ...good });
check("non-owner is rejected", rejected(hack));
const leaked = await provider.callFunction({ contractId, method: "get_record", args: { request_id: id3 } });
check("non-owner write stored nothing", leaked == null);

// 4. Input validation
check("invalid hash is rejected", rejected(await record(ownerAccount, { request_id: run("h"), ...good, request_hash: "not-a-hash" })));
check("empty request_id is rejected", rejected(await record(ownerAccount, { request_id: "", ...good })));
check("over-long request_id is rejected", rejected(await record(ownerAccount, { request_id: "x".repeat(65), ...good })));
check("empty winner_id is rejected", rejected(await record(ownerAccount, { request_id: run("w"), ...good, winner_id: "" })));

// 5. Unknown record
check("unknown request_id returns null", (await provider.callFunction({ contractId, method: "get_record", args: { request_id: "does-not-exist" } })) == null);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
