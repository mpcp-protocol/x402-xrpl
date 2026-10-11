import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryReplayStore,
  SettlementVerificationError,
  buildXrplMemo,
  createChallenge,
  encodeReceiptHeader,
  verifySettlement,
  type FetchTransaction,
  type XrplPaymentTransaction,
} from "../src/index.js";

// Fixtures here test replay and matching invariants, so every transaction is a
// successful one unless it says otherwise (result checks live in conformance.test.ts).
function succeeded(tx: XrplPaymentTransaction): XrplPaymentTransaction {
  return {
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: tx.Amount },
    ...tx,
  };
}

function makeFetchTransaction(
  txByHash: Record<string, XrplPaymentTransaction>,
): FetchTransaction {
  return async (_network, txHash) => {
    const tx = txByHash[txHash];
    return tx === undefined ? null : succeeded(tx);
  };
}

test("replay invariant: same paymentId + same txHash -> idempotent success", async () => {
  const challenge = createChallenge({
    network: "xrpl:testnet",
    amount: "2.5",
    asset: { kind: "XRP" },
    destination: "rDestinationAddress...",
    expiresAt: "2099-01-01T00:00:00Z",
    paymentId: "PAYMENT-001",
  });

  const txHash = "TX-ABC";
  const fetchTransaction = makeFetchTransaction({
    [txHash]: {
      validated: true,
      TransactionType: "Payment",
      Account: "rPayerAddress...",
      Destination: challenge.destination,
      Amount: "2500000",
      Memos: [buildXrplMemo(challenge)],
    },
  });

  const replayStore = new InMemoryReplayStore();
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash,
    paymentId: challenge.paymentId,
  });

  const first = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  assert.equal(first.idempotent, false);
  assert.equal(first.payerAccount, "rPayerAddress...");

  const second = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.receipt.txHash, txHash);
});

test("replay invariant: same paymentId + different txHash -> reject", async () => {
  const challenge = createChallenge({
    network: "xrpl:testnet",
    amount: "2.5",
    asset: { kind: "XRP" },
    destination: "rDestinationAddress...",
    expiresAt: "2099-01-01T00:00:00Z",
    paymentId: "PAYMENT-002",
  });

  const firstTxHash = "TX-ONE";
  const secondTxHash = "TX-TWO";
  const fetchTransaction = makeFetchTransaction({
    [firstTxHash]: {
      validated: true,
      TransactionType: "Payment",
      Account: "rPayerAddress...",
      Destination: challenge.destination,
      Amount: "2500000",
      Memos: [buildXrplMemo(challenge)],
    },
  });

  const replayStore = new InMemoryReplayStore();

  await verifySettlement({
    challenge,
    receiptHeaderValue: encodeReceiptHeader({
      network: challenge.network,
      txHash: firstTxHash,
      paymentId: challenge.paymentId,
    }),
    fetchTransaction,
    replayStore,
  });

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue: encodeReceiptHeader({
          network: challenge.network,
          txHash: secondTxHash,
          paymentId: challenge.paymentId,
        }),
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "replay_detected");
      return true;
    },
  );
});

test("validation invariant: wrong memo / wrong amount -> reject", async () => {
  const challenge = createChallenge({
    network: "xrpl:testnet",
    amount: "2.5",
    asset: { kind: "XRP" },
    destination: "rDestinationAddress...",
    expiresAt: "2099-01-01T00:00:00Z",
    paymentId: "PAYMENT-003",
  });

  const wrongMemoChallenge = createChallenge({
    network: "xrpl:testnet",
    amount: "2.5",
    asset: { kind: "XRP" },
    destination: "rDestinationAddress...",
    expiresAt: "2099-01-01T00:00:00Z",
    paymentId: "PAYMENT-OTHER",
  });

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue: encodeReceiptHeader({
          network: challenge.network,
          txHash: "TX-WRONG-MEMO",
          paymentId: challenge.paymentId,
        }),
        fetchTransaction: makeFetchTransaction({
          "TX-WRONG-MEMO": {
            validated: true,
            TransactionType: "Payment",
            Account: "rPayerAddress...",
            Destination: challenge.destination,
            Amount: "2500000",
            Memos: [buildXrplMemo(wrongMemoChallenge)],
          },
        }),
        replayStore: new InMemoryReplayStore(),
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_memo");
      return true;
    },
  );

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue: encodeReceiptHeader({
          network: challenge.network,
          txHash: "TX-WRONG-AMOUNT",
          paymentId: challenge.paymentId,
        }),
        fetchTransaction: makeFetchTransaction({
          "TX-WRONG-AMOUNT": {
            validated: true,
            TransactionType: "Payment",
            Account: "rPayerAddress...",
            Destination: challenge.destination,
            Amount: "2500001",
            Memos: [buildXrplMemo(challenge)],
          },
        }),
        replayStore: new InMemoryReplayStore(),
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_amount");
      return true;
    },
  );
});
