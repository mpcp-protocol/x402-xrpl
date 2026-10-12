# Changelog

## 0.3.0 (unreleased)

Adds the standard `exact` scheme and the x402 v2 HTTP envelope, so engagement
accounts (and any multisig payer) can be paid through an interoperable flow —
and so the pre-submission signature check that a facilitator must not skip is
built in. See [docs/SPEC-exact.md](docs/SPEC-exact.md).

### Added

- **`exact` scheme** (`x402-xrpl-settlement-adapter/exact`): `verifyExactPayload`
  verifies a presigned `Payment` offline — destination, amount/asset, forbidden
  fields, `InvoiceID` binding, `LastLedgerSequence`, fee policy, sequencing, and
  **signatures**: single-sig against the account's master/regular key, and
  multisig against the payer's on-ledger `SignerList` (each signer authorized,
  no duplicates, summed weights `>= quorum`). `confirmExactSettlement` checks the
  submitted transaction validated with `tesSUCCESS` and the delivered amount,
  replay-safe. Submission stays with the caller's XRPL client (no keys, no sockets).
- **v2 envelope** (`x402-xrpl-settlement-adapter/envelope`): encode/decode for
  `PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`, and the
  `PaymentRequired` / `PaymentRequirements` / `PaymentPayload` / `SettlementResponse`
  types. Re-exported from the root entry.
- `toPaymentRequirements(challenge, { scheme, maxTimeoutSeconds, extra })` bridge,
  and `xrpToDrops` / `dropsToXrp`.
- New dependencies: `ripple-binary-codec`, `ripple-keypairs` (used only by the
  `exact` scheme; the settlement-verification and envelope paths stay dependency-free).

### Changed

- The client-prepaid, receipt-based flow in `./index` is now named the `prepaid`
  scheme. `X-PAYMENT-RECEIPT` still works and is marked deprecated in favour of
  the v2 envelope headers.

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
