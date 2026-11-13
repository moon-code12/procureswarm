# Contract

The contract is implemented in `near/contract/src/lib.rs`. See `near/README.md` for what it stores, its rules, and how to build and deploy it.

Original planning notes (now implemented):

- Owner-only writes, so only the backend signer account can record auctions.
- Write-once records keyed by request ID, so a record cannot be overwritten.
- No personal information on-chain: only a result hash, the winner ID, the total and a timestamp.
