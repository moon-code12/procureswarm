# ProcureSwarm

Group procurement run by AI agents, with every result recorded on the **NEAR testnet**.

A group of buyers pools one bulk order (for example 100 bags of rice). Five **seller agents** bid for it over one or two rounds, five **buyer agents** state how many units each business needs, and an **auctioneer agent** picks the winner. The cost split between the buyers is calculated in code, and a hash of the result is written to a smart contract on NEAR testnet, where anyone can verify it.

> This is a prototype. It uses NEAR **testnet** only (no real money) and the sellers and buyers are fictional.

## What is real, and what is not

| Part | Status |
| --- | --- |
| Seller, buyer and auctioneer decisions | Made by Claude (AI) when `ANTHROPIC_API_KEY` is set. Without it, a simulated value is used. Every bid and buyer is tagged `ai-agent` or `simulated`. |
| Multi-round bidding | After round 1, sellers see the lowest bid and may revise. Prices can't go below each seller's cost floor. |
| Cost split between buyers | Calculated in server code, never by the model. |
| NEAR transactions | Real testnet transactions, shown only after they reach `FINAL` and succeed. |
| Wallet sign-in | A real NEP-413 signature check: it proves a user controls a NEAR account. |
| Payments / escrow | **Not implemented.** The contract records results only. |

## Quick start

You need Node.js 20 or newer. For the contract you also need Rust.

```bash
# 1. Backend
cd server
npm install
cp .env.example .env        # then fill in the values below
npm run dev                 # http://localhost:6000

# 2. Frontend (another terminal)
cd client
npm install
npm run dev                 # http://localhost:6002 (Vite prints the exact address)
```

If the backend is not on port 6000, create `client/.env.local` with `VITE_API_URL=http://localhost:<port>`.

### Settings (`server/.env`)

| Setting | Needed for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Real AI agents. Get one at https://console.anthropic.com. Leave empty to run fully simulated. |
| `NEAR_ACCOUNT_ID`, `NEAR_PRIVATE_KEY`, `NEAR_CONTRACT_ID` | Recording results on NEAR **testnet**. Leave empty to turn NEAR off. |
| `ALLOWED_ORIGINS` | Production: the browser origins allowed to call the API. |
| `SESSION_SECRET` | Keeps wallet sign-ins valid across restarts. |
| `MAX_AUCTIONS_PER_DAY`, `MAX_AUCTIONS_PER_IP_PER_HOUR`, `MAX_CONCURRENT_AUCTIONS`, `MAX_ROUNDS` | Spending limits (see below). |

Never commit `.env`, and never put a private key in frontend code. Use a testnet account only: do **not** use a mainnet (`.near`) account or key.

### Setting up NEAR testnet

1. Install the NEAR CLI (https://docs.near.org/tools/cli) and create a testnet account, for example:
   `near account create-account sponsor-by-faucet-service <name>.testnet use-manually-provided-public-key <ed25519:PUBLIC_KEY> network-config testnet create`
2. Put the account and its private key in `server/.env`.
3. Build the contract: `cd near/contract && cargo build --release --target wasm32-unknown-unknown`
4. Deploy it: `cd server && npm run deploy-contract`, then set `NEAR_CONTRACT_ID` (the account name).

More detail is in [near/README.md](near/README.md).

## Spending protection

Every AI auction makes about 16 AI calls (roughly 8,000 tokens with two rounds). To keep costs predictable, the server enforces:

- **A daily budget**, `MAX_AUCTIONS_PER_DAY` (default 40). It is counted from the saved history, so restarting the server does not reset it.
- **A per-visitor hourly limit**, `MAX_AUCTIONS_PER_IP_PER_HOUR` (default 6).
- **A concurrency cap**, `MAX_CONCURRENT_AUCTIONS` (default 2).
- **Strict input validation** on the quantity, price and product text, which also keeps prompts clean.
- **CORS limited** to local addresses unless `ALLOWED_ORIGINS` is set.

`GET /api/health` shows today's count and the AI tokens used since the server started. Check your real spend in the Anthropic Console.

## Features

- Live progress: the page shows each agent finishing, streamed from the server.
- Bids chart: a diverging bar chart of every bid against your target price, with a table view.
- **Verify on NEAR**: recomputes the result hash and compares it with the on-chain transaction and the contract's stored record (8 checks).
- History of past auctions (saved in `server/data/auctions.json`), which you can reopen and re-verify.
- CSV export of any result (text cells are protected against spreadsheet formula injection).
- Sign in with NEAR: a free signed message proves wallet ownership. Verified accounts are marked as such; a plain account name is labelled self-declared.
- Responsive layout for phones, tablets and desktops.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Mode, limits, today's count, AI usage |
| `POST /api/auction` | Run an auction, return the result |
| `POST /api/auction/stream` | Same, streaming one JSON event per line, then the result |
| `GET /api/auctions`, `GET /api/auctions/:id` | History |
| `POST /api/verify` | Verify a result against NEAR |
| `GET /api/onchain/:id` | Read a record straight from the contract |
| `GET /api/auth/challenge`, `POST /api/auth/login` | Sign in with NEAR |

## Tests

```bash
cd server && npm test      # 37 tests: limits, validation, auctions, history, sign-in, the API
cd client && npm test      # CSV export
cd server && npm run test-contract   # runs against the deployed contract on NEAR testnet (needs .env)
cd near/contract && cargo test       # the contract's own unit tests (first build takes several minutes)
                                     # on Windows without NASM installed: set AWS_LC_SYS_PREBUILT_NASM=1 first
```

## Project layout

```
client/            React + Vite frontend
server/            Express backend (agents, auctions, limits, history, NEAR)
near/contract/     Rust smart contract (result registry)
near/README.md     NEAR details
```

## Known limitations

- No payments or escrow: the contract only records results.
- History is a JSON file (the latest 200 auctions), not a database.
- The contract's error messages reach clients only as a generic "WebAssembly trap".
- Dark theme only.
- Rate limits are kept in memory, so they reset when the server restarts (the daily budget does not).
