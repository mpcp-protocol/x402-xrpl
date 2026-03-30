# x402 XRPL Settlement Adapter Specification

## 1. Overview

This document defines an XRPL (XRP Ledger) settlement adapter for the x402 payment protocol.

The purpose of this adapter is to enable XRPL to function as a settlement rail within x402-compliant payment flows, including HTTP **402 Payment Required** challenge–response interactions.

This adapter:

- Adds XRPL as a supported settlement network (x402 v2 semantics)
- Defines the XRPL payment challenge payload
- Defines the receipt payload and verification requirements
- Specifies memo and idempotency conventions
- Defines replay-protection policy

XRPL is not currently included in the x402 reference SDKs. This adapter is intended to be a compliant, pluggable implementation.

---

## 2. Goals

- Enable XRPL-based settlement for x402 flows
- Support XRP and IOU-based stablecoins
- Ensure deterministic verification and finality
- Prevent replay and duplicate settlement
- Maintain compatibility with x402 v2 header/challenge patterns

Non-goals (v1):

- Cross-currency path payments
- On-ledger escrow
- Facilitator-submitted transactions (v1 assumes **client-submitted** transactions)

---

## 3. Network Identification

This adapter uses CAIP-2 network identifiers.

### Supported Networks

| Network | CAIP-2 ID |
| --- | --- |
| Mainnet | `xrpl:1` |
| Testnet | `xrpl:testnet` |
| Devnet | `xrpl:devnet` |

The `network` field in challenges and receipts **MUST** match one of the supported identifiers.

---

## 4. Supported Assets

### 4.1 Native XRP

```json
{ "kind": "XRP" }
```

**Amount representation**

- In the x402 challenge, `amount` is a **decimal string in XRP** (e.g. `"2.50"`).
- In the XRPL Payment transaction, `Amount` MUST be specified in **drops** (string integer), where:
  - `drops = xrp * 1_000_000`

Rules:

- Exact value match required (after converting challenge XRP → drops)
- No path payments allowed
- No partial payments allowed

### 4.2 IOU Stablecoins

```json
{
  "kind": "IOU",
  "currency": "RLUSD",
  "issuer": "rIssuerAddress..."
}
```

**Amount representation**

- In the x402 challenge, `amount` is a **decimal string** in the IOU’s units (e.g. `"2.50"`).
- In the XRPL Payment transaction, `Amount` MUST be an **XRPL issued-currency Amount object** with:
  - `currency`
  - `issuer`
  - `value` (decimal string)

Rules:

- Currency and issuer MUST match exactly
- Value MUST match exactly (string compare in v1)
- No path-based conversions in v1

---

## 5. x402 Challenge Structure

When an unpaid request is received, the server responds with HTTP 402 and includes a JSON challenge.

### Challenge JSON

```json
{
  "version": "2",
  "network": "xrpl:testnet",
  "amount": "2.50",
  "asset": { "kind": "XRP" },
  "destination": "rDestinationAddress...",
  "expiresAt": "2026-02-17T12:00:00Z",
  "paymentId": "01HZY3J8S3A7XK4Z9T8B",
  "memo": {
    "format": "x402",
    "paymentId": "01HZY3J8S3A7XK4Z9T8B",
    "sessionId": "optional"
  }
}
```

Field requirements:

- `version`: MUST be `"2"`
- `network`: CAIP-2 identifier
- `amount`: decimal string
- `asset`: supported asset object
- `destination`: XRPL classic address
- `expiresAt`: ISO-8601 UTC timestamp
- `paymentId`: unique idempotency key
- `memo`: memo binding fields

---

## 6. XRPL Transaction Requirements

The client MUST submit an XRPL `Payment` transaction that satisfies:

- `TransactionType` = `Payment`
- `Destination` = `challenge.destination`
- `Amount` matches the challenge
- Transaction MUST be **validated** on-ledger
- MUST include an XRPL Memo binding to `challenge.paymentId`

The client then returns a receipt containing the validated transaction hash.

---

## 7. Memo Convention

XRPL Memos bind payment to the x402 intent.

Memo fields:

- `MemoType`: `"x402"`
- `MemoFormat`: `"application/json"`
- `MemoData`: **hex-encoded UTF-8 JSON**

Decoded JSON:

```json
{
  "v": 1,
  "t": "x402",
  "paymentId": "01HZY3J8S3A7XK4Z9T8B",
  "sessionId": "optional"
}
```

Verification rules:

- Memo MUST exist
- MemoData MUST decode to valid JSON
- `paymentId` MUST equal `challenge.paymentId`
- If sessionId provided in challenge, it MUST match

---

## 8. Receipt Format

Header name:

- `X-PAYMENT-RECEIPT`

Header value:

- base64-encoded UTF-8 JSON

Decoded JSON:

```json
{
  "network": "xrpl:testnet",
  "txHash": "ABCDEF123...",
  "paymentId": "01HZY3J8S3A7XK4Z9T8B"
}
```

Field requirements:

- `network` MUST equal `challenge.network`
- `paymentId` MUST equal `challenge.paymentId`
- `txHash` MUST be validated

---

## 9. Verification Algorithm

Given a `challenge` and `receipt`, the server MUST:

1. Confirm `receipt.network == challenge.network`
2. Confirm `receipt.paymentId == challenge.paymentId`
3. Fetch transaction by `receipt.txHash`
4. Confirm:
   - `validated == true`
   - `TransactionType == "Payment"`
   - `Destination == challenge.destination`
   - Memo matches
5. Reject if any of these are present:
   - `Paths`
   - `SendMax`
   - `DeliverMin`
   - Partial payment flag
6. Confirm Amount matches exactly
7. Enforce replay rules:
   - Same `paymentId` + same `txHash` → idempotent success
   - Same `paymentId` + different `txHash` → reject
   - Same `txHash` + different `paymentId` → reject
8. Atomically store `paymentId` + `txHash`
9. Return success

---

## 10. Idempotency and Replay Protection

- `paymentId` MUST be unique per payment attempt
- Challenge expiry enforced via `expiresAt`

---

## 11. Error Codes

| Code | Description |
| --- | --- |
| `expired_challenge` | Payment after TTL |
| `network_mismatch` | Wrong network |
| `invalid_amount` | Amount mismatch |
| `invalid_asset` | Asset mismatch or disallowed field (Paths, SendMax, DeliverMin, partial payment flag) |
| `invalid_destination` | Destination mismatch, or `DestinationTag` present (not supported in v1 safe mode) |
| `invalid_memo` | Memo missing, malformed, `paymentId` mismatch, or `sessionId` mismatch |
| `invalid_receipt` | Receipt malformed |
| `replay_detected` | `paymentId` or `txHash` reused |
| `tx_not_validated` | Transaction not validated |
| `tx_not_found` | Unknown `txHash` |

### Notes on specific codes

**`invalid_destination` and DestinationTag**

In v1 safe mode, any transaction that includes a `DestinationTag` is rejected with `invalid_destination`. This prevents address ambiguity on exchanges and custodial accounts that share a classic address across users via DestinationTag routing. Support for DestinationTag is deferred to a future version.

**`invalid_asset` and IOU amount comparison**

IOU `value` fields are compared with exact string equality against the challenge `amount` (after decimal normalisation at challenge creation time via `createChallenge`). XRPL clients that produce scientific notation (e.g. `"1e-5"` instead of `"0.00001"`) will fail this check. Integrators MUST ensure their XRPL client serialises IOU values as normalised decimal strings. Automatic normalisation on the verifier side is deferred to v2.

**`fetchTransaction` network contract**

The adapter passes `network` to the `fetchTransaction` callback but does not re-verify that the returned transaction originates from that network. Integrators MUST ensure their `fetchTransaction` implementation fetches from the correct network. Returning a testnet transaction in response to a mainnet `txHash` lookup is an integration bug, not a protocol error.

---

## 12. Version

Initial version: `0.1.0`

---

## 13. Compliance Checklist

An implementation is **conformant** with this spec if all items below are true.

### Challenge

- [ ] Responds with HTTP 402 for unpaid requests and includes a JSON challenge.
- [ ] Challenge includes: `version`, `network`, `amount`, `asset`, `destination`, `expiresAt`, `paymentId`, `memo`.
- [ ] `version` is exactly `"2"`.
- [ ] `network` is one of: `xrpl:1`, `xrpl:testnet`, `xrpl:devnet`.
- [ ] `amount` is a decimal string.
- [ ] `asset.kind` is `XRP` or `IOU`.

### XRPL Payment Transaction

- [ ] Requires `TransactionType == "Payment"`.
- [ ] Requires `validated == true`.
- [ ] Requires `Destination == challenge.destination`.
- [ ] Rejects if any of the following are present: `Paths`, `SendMax`, `DeliverMin`.
- [ ] Rejects if the Partial Payment flag is set.

### Amount Matching

- [ ] **XRP:** Converts `challenge.amount` (XRP) to drops and compares exact equality against tx `Amount` (drops string).
- [ ] **IOU:** Requires exact equality on `currency`, `issuer`, and `value`.

### Memo Binding

- [ ] Requires an XRPL Memo.
- [ ] Decodes MemoData as hex → UTF-8 → JSON.
- [ ] Requires memo JSON to include `paymentId` matching `challenge.paymentId`.
- [ ] If `challenge.memo.sessionId` exists, requires memo `sessionId` to match.

### Receipt

- [ ] Accepts `X-PAYMENT-RECEIPT` header containing base64-encoded UTF-8 JSON.
- [ ] Receipt JSON includes: `network`, `txHash`, `paymentId`.
- [ ] Requires `receipt.network == challenge.network`.
- [ ] Requires `receipt.paymentId == challenge.paymentId`.

### Replay Protection (Idempotency)

- [ ] Stores `paymentId -> txHash` with an atomic write.
- [ ] Same `paymentId` + same `txHash` returns idempotent success.
- [ ] Same `paymentId` + different `txHash` is rejected as `replay_detected`.
- [ ] Same `txHash` + different `paymentId` is rejected as `replay_detected`.