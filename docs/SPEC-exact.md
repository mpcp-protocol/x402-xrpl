# x402 XRPL `exact` scheme

The `exact` scheme is the standard, interoperable x402 XRPL payment flow: the
client sends a **presigned** `Payment` transaction, the facilitator verifies it
(signatures included) and submits it. This complements the client-prepaid flow
in [`SPEC.md`](./SPEC.md), where the client submits the transaction itself and
returns a receipt.

Implemented in `./exact` (import `x402-xrpl-settlement-adapter/exact`). The HTTP
envelope is in [`./envelope`](../src/envelope.ts).

## 1. Envelope

x402 v2 headers (base64-encoded JSON):

| Header | Direction | Body |
| --- | --- | --- |
| `PAYMENT-REQUIRED` | 402 response | `PaymentRequired` (`accepts: PaymentRequirements[]`) |
| `PAYMENT-SIGNATURE` | retry request | `PaymentPayload` (`accepted`, `payload`) |
| `PAYMENT-RESPONSE` | success response | `SettlementResponse` |

`PaymentRequirements` for `exact`:

```json
{
  "scheme": "exact",
  "network": "xrpl:1",
  "amount": "2500000",
  "asset": "XRP",
  "payTo": "rMerchant...",
  "maxTimeoutSeconds": 60,
  "extra": { "areFeesSponsored": false, "invoiceId": "01JAB...", "issuer": "rIssuer..." }
}
```

- `amount` is in **atomic units**: drops for XRP, the issued-currency decimal value for an IOU.
- `network` is CAIP-2: `xrpl:0` mainnet, `xrpl:1` testnet, `xrpl:2` devnet.
- `extra.areFeesSponsored` MUST be `false` (the payer pays the XRPL fee).
- `extra.invoiceId` (optional) binds the payment: the transaction's `InvoiceID` MUST equal `SHA-256(invoiceId)` as uppercase hex.
- `extra.issuer` is required for an IOU.
- `extra.destinationTag` (optional) must match the transaction's `DestinationTag`.
- `extra.assetTransferMethod` is `"sequence"` (default) or `"ticketSequence"`.

`PaymentPayload.payload` for `exact`:

```json
{ "signedTxBlob": "120000228000..." }
```

## 2. Verification (`verifyExactPayload`)

Offline, against the payer's state at the latest validated ledger. No submission.

1. Decode `signedTxBlob`. Must be a `Payment`.
2. `Destination == payTo`; `Amount` present and equal to the requirements (drops for XRP; currency+issuer+value for IOU).
3. Reject `Memos`, `Delegate`, `Paths`, `DeliverMin`, the `tfPartialPayment` flag, and `SendMax` for XRP. For an IOU, `SendMax` is allowed only if it equals the exact amount.
4. `DestinationTag` matches `extra.destinationTag` when pinned.
5. `InvoiceID == SHA-256(invoiceId)` when `extra.invoiceId` is present.
6. `LastLedgerSequence` present, and within `ceil(maxTimeoutSeconds / 5) + 2` of the validated ledger (when a ledger index is supplied).
7. `Fee` within policy (when a policy is supplied).
8. Sequencing: `sequence` mode forbids `TicketSequence` and (when account state is supplied) requires `Sequence` to match; `ticketSequence` mode requires `Sequence == 0` and a `TicketSequence` that is an available ticket.
9. **Signatures:**
   - **Single-signed:** verify `TxnSignature` over the signing data with `SigningPubKey`; the key MUST be the account's master key (not disabled) or its regular key.
   - **Multisigned** (`Signers` present, `SigningPubKey` empty): for each signer, verify `TxnSignature` over the multisigning data; the signer MUST be on the payer's `SignerList`, with no duplicates; each signer's key MUST be that signer account's master (not disabled) or regular key; the summed weights MUST be `>= SignerQuorum`.

A validated facilitator never serves a resource on `/verify` for a payment that would fail at submission. `simulate` cannot replace step 9: signature fields are stripped before simulation.

## 3. Settlement

The caller submits the verified `signedTxBlob` with its own XRPL client (this
package holds no keys and does not open sockets), then calls
`confirmExactSettlement` with the resulting transaction hash. Confirmation
requires `validated == true`, `meta.TransactionResult == "tesSUCCESS"`,
`meta.delivered_amount` equal to the requirements, the destination, and the
invoice binding; it is replay-safe on `paymentId` (default: `extra.invoiceId`,
else the tx hash).

## 4. Error codes (`ExactVerificationError.code`)

`invalid_payload`, `invalid_transaction`, `wrong_transaction_type`,
`destination_mismatch`, `amount_mismatch`, `asset_mismatch`, `forbidden_field`,
`invoice_mismatch`, `destination_tag_mismatch`, `sequencing_invalid`,
`expiry_invalid`, `fee_too_high`, `signature_invalid`, `signer_not_authorized`,
`quorum_not_met`, `account_not_found`, `tx_failed`, `replay_detected`.

## 5. Flow

```
402  → PAYMENT-REQUIRED: { accepts: [ exact requirements ] }
retry → PAYMENT-SIGNATURE: { accepted, payload: { signedTxBlob } }
server: verifyExactPayload(...)           // offline, signatures included
server: submit(signedTxBlob) via its XRPL client
server: confirmExactSettlement(txHash)    // tesSUCCESS + delivered + replay
200  → PAYMENT-RESPONSE: { success, transaction, network, payer }
```
