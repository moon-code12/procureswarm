# NEAR testnet integration

ProcureSwarm records a hash of each completed auction on **NEAR testnet**. Testnet is NEAR's practice network: transactions are real and publicly verifiable, but tokens have no value.

## What is real and what is not

| Part | Status |
| --- | --- |
| Seller, buyer and auctioneer decisions | Made by AI models (Claude) when `ANTHROPIC_API_KEY` is set; otherwise simulated. Each bid and buyer is tagged `ai-agent` or `simulated`. |
| Cost split between buyers | Calculated in server code, never by the model. |
| Auction records | Held by the backend per request, with the winner hash recorded on-chain. |
| Seller bids | Sealed on-chain commitments, then revealed and checked against their original hash. |
| NEAR transactions | Real testnet transactions, shown only after they reach `FINAL` and succeed. |

If NEAR is not configured, or a transaction fails, the API returns `onChain.status` of `not-configured` or `failed`, and no hash or link is shown.

## Sealed-bid commit/reveal

Each seller may commit once per auction by calling `commit_bid(auction_id, commitment)` from its own account. The commitment is the lowercase SHA-256 hash of:

`auction_id|seller_account_id|unit_price|quantity|salt`

The seller later calls `reveal_bid` with the original price, quantity and salt. The contract recomputes the hash and rejects a changed bid. The backend can then record the auctioneer's selected winner with the existing owner-only `record_auction` method.

## Testnet escrow

The contract also supports an opt-in escrow flow using testnet NEAR. Each buyer calls payable `deposit_escrow(auction_id)` once. The owner can call `confirm_delivery(auction_id, seller_id)` to transfer all open deposits to the winning seller, or `refund_escrow(auction_id)` to return them to the depositing buyers. The auction API exposes the required amount in `auction.escrow`, but never deposits funds automatically.

## What goes on-chain

Only minimal public data, in `near/contract`:

- `request_id`: the auction ID
- `request_hash`: SHA-256 of the full auction result (the result itself stays off-chain)
- `winner_id`: the winning seller's ID
- `total_amount`: total in whole naira
- `created_at`: block timestamp
- sealed bid commitments and their revealed price/quantity, keyed by auction and seller account

No names, contacts or other personal or business data are stored.

## Contract rules

- Any seller account can call `commit_bid` and reveal only its own bid.
- Only the owner account (the backend signer) can call `record_auction`.
- Records are write-once: a duplicate `request_id` is rejected.
- `request_hash` must be a 64-character hex string; IDs must be 1-64 characters.
- `get_record(request_id)` reads a record back.

## Setup

1. Create a testnet account (the name must end in `.testnet`). With the official CLI:
   `near account create-account sponsor-by-faucet-service <name>.testnet use-manually-provided-public-key <ed25519:PUBLIC_KEY> network-config testnet create`
2. In `server/.env` set `NEAR_ACCOUNT_ID` and `NEAR_PRIVATE_KEY`. The key stays on the backend and must never appear in frontend code or in git.
3. Build the contract: `cargo build --release --target wasm32-unknown-unknown` in `near/contract`.
4. Deploy and initialise it: `npm run deploy-contract` in `server`, then set `NEAR_CONTRACT_ID` in `server/.env`.
5. Start the server. `GET /api/health` should report `"near": "testnet"`.

## Verifying a result

`GET /api/onchain/:requestId` returns the stored record. Compare its `request_hash` with the `onChain.requestHash` from the auction response, and open `onChain.explorerUrl` to see the transaction on nearblocks.

## Known gaps

- The contract's Rust unit tests (in `near/contract/src/lib.rs`) pass (5 of 5). On Windows without NASM, run them with `AWS_LC_SYS_PREBUILT_NASM=1 cargo test`; the first build takes several minutes.
- Contract rules are tested against testnet with `npm run test-contract` (in `server`): owner-only writes, write-once records, and input validation. Each run creates a throwaway sub-account that costs 0.2 testnet NEAR.
- Rejected calls show only a generic "WebAssembly trap" to clients. The contract's readable error messages do not reach the client, so tests confirm a call is rejected, not the message text.
- Testnet only. Do not use a mainnet (`.near`) account or key with this project.
