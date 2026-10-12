# Changelog

## 0.2.0 (unreleased)

### Security

- **Require a successful transaction, not just a validated one.** `verifySettlement` now requires `meta.TransactionResult === "tesSUCCESS"` and checks `meta.delivered_amount` against the challenge. Before, a Payment that was validated with a `tec*` result (fee charged, nothing delivered) passed verification. New error code: `tx_failed`. `fetchTransaction` must now return `meta`; without it verification fails closed. Use `fromRippledTx` to map rippled/Clio `tx` results.

### Breaking

- **CAIP-2 network IDs.** `xrpl:0` = Mainnet, `xrpl:1` = Testnet, `xrpl:2` = Devnet, matching xrpl.org and the x402 Foundation XRPL scheme; `xrpl:mainnet` / `xrpl:testnet` / `xrpl:devnet` are accepted aliases. `xrpl:1` previously meant **Mainnet** in this package. Migrate Mainnet challenges to `xrpl:0` (or `xrpl:mainnet`) before upgrading. `fetchTransaction` now receives the canonical ID.

### Changed

- **Expiry is checked against when the payment was made.** When `fetchTransaction` returns `closeTime` (the validating ledger's close time), a payment validated before `expiresAt` is accepted even if its receipt arrives shortly after. Receipts presented more than `settlementGraceSeconds` (default 60) after `expiresAt` are rejected.
- **API v2:** `DeliverMax` is accepted in place of `Amount`.

### Added

- `fromRippledTx(result)`, `canonicalNetwork(network)`, `CANONICAL_NETWORKS`, `NETWORK_ALIASES`, `XrplTransactionMeta`.
- Conformance vectors v2: every transaction carries `meta`; 11 new cases (failed result, missing metadata, delivered-amount mismatch and unavailability, `DeliverMax`, CAIP-2 aliases and mismatch, ledger-time expiry and grace). Vector steps may set `now`.

### Migration

1. Return metadata from `fetchTransaction` (simplest: `return fromRippledTx((await client.request({ command: "tx", transaction: txHash })).result)`).
2. Replace Mainnet `xrpl:1` with `xrpl:0` in challenges, and key network maps by `xrpl:0` / `xrpl:1` / `xrpl:2`.
3. The README usage example's mocked `fetchTransaction` needs `meta: { TransactionResult: "tesSUCCESS", delivered_amount: "2500000" }`.
