import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryReplayStore,
  SettlementVerificationError,
  buildXrplMemo,
  createChallenge,
  encodeReceiptHeader,
  verifySettlement,
  type ChallengeAsset,
  type FetchTransaction,
  type XrplNetwork,
  type XrplPaymentTransaction,
} from "../src/index.js";

// Helper: XRP decimal string -> drops string (no floats)
function xrpToDrops(xrp: string): string {
  const m = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(xrp);
  if (!m) {
    throw new Error("bad xrp");
  }
  const [intPart, fracRaw = ""] = xrp.split(".");
  if (fracRaw.length > 6) {
    throw new Error("too many decimals");
  }
  const frac = fracRaw.padEnd(6, "0");
  return (intPart.replace(/^0+(?=\d)/, "") || "0") + frac;
}

function baseChallenge(
  params?: Partial<{
    network: XrplNetwork;
    amount: string;
    asset: ChallengeAsset;
    destination: string;
    expiresAt: string;
    paymentId: string;
    sessionId?: string;
  }>,
) {
  return createChallenge({
    network: params?.network ?? "xrpl:testnet",
    amount: params?.amount ?? "1.5",
    asset: params?.asset ?? { kind: "XRP" },
    destination: params?.destination ?? "rDEST",
    expiresAt: params?.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    paymentId: params?.paymentId ?? "01HZY3J8S3A7XK4Z9T8B",
    sessionId: params?.sessionId,
  });
}

function makeTx(
  challenge: ReturnType<typeof baseChallenge>,
  overrides?: Partial<XrplPaymentTransaction>,
): XrplPaymentTransaction {
  const memos = [buildXrplMemo(challenge)];
  const amount =
    challenge.asset.kind === "XRP"
      ? xrpToDrops(challenge.amount)
      : {
          currency: challenge.asset.currency,
          issuer: challenge.asset.issuer,
          value: challenge.amount,
        };

  return {
    validated: true,
    TransactionType: "Payment",
    Account: "rPAYER",
    Destination: challenge.destination,
    Amount: amount as XrplPaymentTransaction["Amount"],
    Memos: memos,
    ...overrides,
  };
}

test("1) happy path: XRP", async () => {
  const challenge = baseChallenge({ amount: "2.5", asset: { kind: "XRP" } });
  const receipt = {
    network: challenge.network,
    txHash: "TX1",
    paymentId: challenge.paymentId,
  };
  const receiptHeaderValue = encodeReceiptHeader(receipt);

  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  const res = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  assert.equal(res.ok, true);
  assert.equal(res.idempotent, false);
  assert.equal(res.payerAccount, "rPAYER");
});

test("2) happy path: IOU", async () => {
  const challenge = baseChallenge({
    amount: "10.25",
    asset: { kind: "IOU", currency: "RLUSD", issuer: "rISSUER" },
  });

  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX2",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  const res = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  assert.equal(res.ok, true);
});

test("3) replay idempotent: same paymentId + same txHash", async () => {
  const challenge = baseChallenge({ paymentId: "P1" });
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX3",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  const res2 = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });

  assert.equal(res2.ok, true);
  assert.equal(res2.idempotent, true);
});

test("4) replay reject: same paymentId + different txHash", async () => {
  const challenge = baseChallenge({ paymentId: "P2" });

  const receiptA = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TXA",
    paymentId: challenge.paymentId,
  });
  const receiptB = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TXB",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  await verifySettlement({
    challenge,
    receiptHeaderValue: receiptA,
    fetchTransaction,
    replayStore,
  });

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue: receiptB,
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

test("5) wrong memo paymentId => invalid_memo", async () => {
  const challenge = baseChallenge({ paymentId: "P3" });
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX5",
    paymentId: challenge.paymentId,
  });

  const badMemoTx = makeTx(challenge, {
    Memos: [
      buildXrplMemo({
        ...challenge,
        paymentId: "DIFF",
        memo: { ...challenge.memo, paymentId: "DIFF" },
      }),
    ],
  });

  const fetchTransaction: FetchTransaction = async () => badMemoTx;
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_memo");
      return true;
    },
  );
});

test("6) malformed receipt => invalid_receipt", async () => {
  const challenge = baseChallenge();
  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue: "not-base64",
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_receipt");
      return true;
    },
  );
});

test("7) Paths present => invalid_asset", async () => {
  const challenge = baseChallenge();
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX7",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () =>
    makeTx(challenge, { Paths: [{}] });
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_asset");
      return true;
    },
  );
});

test("8) partial payment flag set => invalid_asset", async () => {
  const challenge = baseChallenge();
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX8",
    paymentId: challenge.paymentId,
  });

  const PARTIAL = 0x00020000;
  const fetchTransaction: FetchTransaction = async () =>
    makeTx(challenge, { Flags: PARTIAL });
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_asset");
      return true;
    },
  );
});

test("9) unvalidated tx => tx_not_validated", async () => {
  const challenge = baseChallenge();
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX9",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () =>
    makeTx(challenge, { validated: false });
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "tx_not_validated");
      return true;
    },
  );
});

test("10a) sessionId matches in memo => ok", async () => {
  const challenge = baseChallenge({ sessionId: "sess-abc" });
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX10a",
    paymentId: challenge.paymentId,
  });

  // buildXrplMemo includes sessionId from challenge.memo.sessionId
  const fetchTransaction: FetchTransaction = async () => makeTx(challenge);
  const replayStore = new InMemoryReplayStore();

  const res = await verifySettlement({
    challenge,
    receiptHeaderValue,
    fetchTransaction,
    replayStore,
  });
  assert.equal(res.ok, true);
  assert.equal(res.idempotent, false);
});

test("10b) sessionId mismatch in memo => invalid_memo", async () => {
  const challenge = baseChallenge({ sessionId: "sess-abc" });
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX10b",
    paymentId: challenge.paymentId,
  });

  // Build memo with a different sessionId
  const badMemoTx = makeTx(challenge, {
    Memos: [
      buildXrplMemo({
        ...challenge,
        memo: { ...challenge.memo, sessionId: "sess-WRONG" },
      }),
    ],
  });

  const fetchTransaction: FetchTransaction = async () => badMemoTx;
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_memo");
      return true;
    },
  );
});

test("10c) sessionId in challenge but absent in memo => invalid_memo", async () => {
  const challenge = baseChallenge({ sessionId: "sess-abc" });
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX10c",
    paymentId: challenge.paymentId,
  });

  // Build memo without sessionId
  const noSessionMemoTx = makeTx(challenge, {
    Memos: [
      buildXrplMemo({
        ...challenge,
        memo: { format: "x402", paymentId: challenge.paymentId },
      }),
    ],
  });

  const fetchTransaction: FetchTransaction = async () => noSessionMemoTx;
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "invalid_memo");
      return true;
    },
  );
});

test("10) tx not found => tx_not_found", async () => {
  const challenge = baseChallenge();
  const receiptHeaderValue = encodeReceiptHeader({
    network: challenge.network,
    txHash: "TX10",
    paymentId: challenge.paymentId,
  });

  const fetchTransaction: FetchTransaction = async () => null;
  const replayStore = new InMemoryReplayStore();

  await assert.rejects(
    () =>
      verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
      }),
    (error: unknown) => {
      assert(error instanceof SettlementVerificationError);
      assert.equal(error.code, "tx_not_found");
      return true;
    },
  );
});
