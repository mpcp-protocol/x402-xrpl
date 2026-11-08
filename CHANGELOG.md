# Changelog

## Unreleased

### Changed

- Multisig verification in the `exact` scheme fetches signer account states
  concurrently instead of one at a time, so a payment with N signers waits on
  one round of ledger lookups instead of N. All local checks (entry shape,
  duplicates, SignerList membership, signatures) still run first, in signer
  order, before any lookup. If several signers fail key authorization, the
  error names the first one in signer order.
- When one signer's key is unauthorized and a later signer's signature is
  invalid, verification now reports `multisig_signature_invalid` (previously
  `multisig_signer_not_authorized`). The payment is rejected either way.

## 0.4.0 (2026-11-08)

### Changed

- **Breaking:** multisig verification in the `exact` scheme now fails with
  dedicated error codes — `multisig_signer_not_authorized`,
  `multisig_quorum_not_met`, `multisig_signature_invalid` and
  `multisig_account_not_found` — instead of reusing the single-sig codes.
  Callers that match `signer_not_authorized`, `quorum_not_met`,
  `signature_invalid` or `account_not_found` on multisig failures must switch
  to the new codes.
- **Breaking (types):** `quorum_not_met` and `account_not_found` are removed
  from `ExactErrorCode`. Only multisig verification returned them, so
  TypeScript now flags code that still checks for them.
- `package.json` declares `"engines": { "node": ">=22" }`. The test script
  relies on Node expanding the glob passed to `--test`, which Node 20 does
  not do.
- Relicensed from MIT to Apache-2.0.

### Added

- `XrplPaymentTransaction.InvoiceID` (optional). `confirmExactSettlement`
  already read it; the field was missing from the type.

## 0.3.0 (2026-10-12)

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

## 0.2.0 (not published; shipped in 0.3.0)

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
