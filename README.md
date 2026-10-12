# x402-xrpl-settlement-adapter

Strict **server-side settlement verifier** for x402 v2 on XRPL.

This package verifies that a client actually fulfilled an x402 Payment Required challenge on the XRP Ledger. It is designed for backend services that need strong guarantees around on-ledger settlement.

Unlike generic SDKs, this adapter focuses on **security and determinism**, enforcing:

- Exact amount matching (XRP drops or IOU value)
- Exact currency + issuer matching (for IOUs / RLUSD)
- Memo binding to `paymentId`
- Replay protection (paymentId ↔ txHash invariant)
- Rejection of partial payments
- Rejection of path payments (Paths / SendMax / DeliverMin)
- Safe-mode enforcement (no DestinationTag support)

---

## What This Is

Strict server-side settlement verifier for x402 v2 payments on XRPL (XRP & issued tokens such as RLUSD). Validates presigned XRPL Payment transactions and enforces deterministic settlement rules for HTTP 402 flows.

Designed for:

- API gateways
- Payment middleware
- Backend services issuing x402 challenges
- Infrastructure providers integrating XRPL as a settlement layer

---

## What This Is NOT

- Not a wallet SDK
- Not a signing library
- Not a presigned transaction builder
- Not a client-side payment helper

This is the server-side enforcement layer.

## Schemes

Two settlement schemes, both server-side enforced:

- **`prepaid`** (`./index`) — the client submits the XRPL `Payment` itself and
  returns the transaction hash; the server verifies the validated transaction
  (amount, memo binding, `tesSUCCESS`, replay). This is the original flow. See
  [docs/SPEC.md](docs/SPEC.md).
- **`exact`** (`./exact`) — the standard, interoperable x402 XRPL flow: the
  client sends a **presigned** `Payment` blob, the server verifies it **offline
  — signatures and multisig quorum included — before anything is submitted**,
  then submits and confirms `tesSUCCESS`. Works for multisig payers (e.g.
  engagement accounts). See [docs/SPEC-exact.md](docs/SPEC-exact.md).

The x402 v2 HTTP envelope (`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` /
`PAYMENT-RESPONSE`) is in [`./envelope`](src/envelope.ts).

> Offline signature verification is not optional in `exact`: a facilitator that
> answers `/verify` without it can be made to report a payment as valid that the
> ledger will reject at submission, so a merchant that serves on `/verify` would
> deliver for nothing. `verifyExactPayload` refuses below-quorum, wrong-signer,
> and tampered transactions.

## Quick start

```bash
pnpm install
pnpm dev
```

## Scripts

- `pnpm dev` — run `src/index.ts` with `tsx`
- `pnpm build` — bundle and emit types to `dist/` with `tsup`
- `pnpm format` — format all files with Prettier
- `pnpm format:check` — verify formatting without writing changes
- `pnpm test` — run settlement adapter tests

## Usage example

```ts
import {
  InMemoryReplayStore,
  buildXrplMemo,
  createChallenge,
  encodeReceiptHeader,
  verifySettlement,
  type FetchTransaction,
} from "./src/index.js";

const challenge = createChallenge({
  network: "xrpl:testnet",
  amount: "2.5",
  asset: { kind: "XRP" },
  destination: "rDestinationAddress...",
  expiresAt: "2026-02-17T12:00:00Z",
  paymentId: "01JABCXYZPAYMENTID",
});

const xrplMemo = buildXrplMemo(challenge);
console.log("Attach this memo to your XRPL Payment:", xrplMemo);

const receiptHeaderValue = encodeReceiptHeader({
  network: challenge.network,
  txHash: "ABCDEF123...",
  paymentId: challenge.paymentId,
});

const fetchTransaction: FetchTransaction = async () => ({
  validated: true,
  TransactionType: "Payment",
  Destination: challenge.destination,
  // XRP is represented in drops on XRPL.
  Amount: "2500000",
  Memos: [xrplMemo],
});

const replayStore = new InMemoryReplayStore();

const result = await verifySettlement({
  challenge,
  receiptHeaderValue,
  fetchTransaction,
  replayStore,
});

console.log(result);
// { ok: true, idempotent: false, receipt: { ... } }
```

Second call with the same `paymentId` + `txHash` returns idempotent success.
