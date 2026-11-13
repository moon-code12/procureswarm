// Deploys the ProcureSwarm registry contract to NEAR testnet and initialises it.
// Usage (from /server): npm run deploy-contract
// Requires NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in .env. The contract is deployed to that same account
// and the account is set as the owner (the only account allowed to record auctions).
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider } from "near-api-js";

const accountId = process.env.NEAR_ACCOUNT_ID;
const privateKey = process.env.NEAR_PRIVATE_KEY;
if (!accountId || !privateKey) {
  console.error("Set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in server/.env first.");
  process.exit(1);
}

const wasmPath = new URL("../../near/contract/target/wasm32-unknown-unknown/release/procureswarm_registry.wasm", import.meta.url);
const wasm = readFileSync(wasmPath);

const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org" });
const account = new Account(accountId, provider, privateKey);

console.log(`Deploying ${wasm.length} bytes to ${accountId} on testnet...`);
const deploy = await account.deployContract(wasm);
console.log("Deployed. tx:", deploy.transaction?.hash);

try {
  await account.callFunction({ contractId: accountId, methodName: "new", args: { owner: accountId }, waitUntil: "FINAL" });
  console.log(`Initialised with owner ${accountId}.`);
} catch (err) {
  console.error("init failed (it may already be initialised):", err.message);
}
console.log(`\nNow set NEAR_CONTRACT_ID=${accountId} in server/.env`);
