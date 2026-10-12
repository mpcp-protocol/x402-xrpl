import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryReplayStore,
  SettlementVerificationError,
  buildXrplMemo,
  canonicalNetwork,
  createChallenge,
  encodeReceiptHeader,
  fromRippledTx,
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

  const tx: XrplPaymentTransaction = {
    validated: true,
    TransactionType: "Payment",
    Account: "rPAYER",
    Destination: challenge.destination,
    Amount: amount as XrplPaymentTransaction["Amount"],
    Memos: memos,
    ...overrides,
  };
  // Successful by default, delivering exactly what was sent.
  if (overrides === undefined || !("meta" in overrides)) {
    tx.meta = {
      TransactionResult: "tesSUCCESS",
      delivered_amount: tx.Amount ?? tx.DeliverMax,
    };
  }
  return tx;
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

// ── 0.2.0: transaction result, delivered amount, networks, ledger-time expiry ──

async function verifyWith(
  challenge: ReturnType<typeof baseChallenge>,
  tx: XrplPaymentTransaction,
  opts: {
    now?: Date;
    receiptNetwork?: XrplNetwork;
    settlementGraceSeconds?: number;
  } = {},
) {
  const seen: string[] = [];
  const fetchTransaction: FetchTransaction = async (network) => {
    seen.push(network);
    return tx;
  };
  const result = await verifySettlement({
    challenge,
    receiptHeaderValue: encodeReceiptHeader({
      network: opts.receiptNetwork ?? challenge.network,
      txHash: "TX-1",
      paymentId: challenge.paymentId,
    }),
    fetchTransaction,
    replayStore: new InMemoryReplayStore(),
    now: opts.now,
    settlementGraceSeconds: opts.settlementGraceSeconds,
  });
  return { result, seen };
}

async function rejectsWith(code: string, p: Promise<unknown>) {
  await assert.rejects(p, (error: unknown) => {
    assert(error instanceof SettlementVerificationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("11) validated but failed (tec) => tx_failed", async () => {
  const challenge = baseChallenge();
  const tx = makeTx(challenge, {
    meta: { TransactionResult: "tecUNFUNDED_PAYMENT", delivered_amount: "0" },
  });
  await rejectsWith("tx_failed", verifyWith(challenge, tx));
});

test("12) missing metadata => tx_failed (fail closed)", async () => {
  const challenge = baseChallenge();
  await rejectsWith(
    "tx_failed",
    verifyWith(challenge, makeTx(challenge, { meta: undefined })),
  );
});

test("13) delivered_amount differs from the challenge => invalid_amount", async () => {
  const challenge = baseChallenge({ amount: "1.5" });
  const tx = makeTx(challenge, {
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1499999" },
  });
  await rejectsWith("invalid_amount", verifyWith(challenge, tx));
});

test("14) delivered_amount unavailable => tx_failed", async () => {
  const challenge = baseChallenge();
  const tx = makeTx(challenge, {
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: "unavailable" },
  });
  await rejectsWith("tx_failed", verifyWith(challenge, tx));
});

test("15) IOU: delivered issuer must match", async () => {
  const challenge = baseChallenge({
    amount: "10",
    asset: { kind: "IOU", currency: "RLUSD", issuer: "rISSUER" },
  });
  const tx = makeTx(challenge, {
    meta: {
      TransactionResult: "tesSUCCESS",
      delivered_amount: { currency: "RLUSD", issuer: "rOTHER", value: "10" },
    },
  });
  await rejectsWith("invalid_asset", verifyWith(challenge, tx));
});

test("16) API v2 DeliverMax instead of Amount => ok", async () => {
  const challenge = baseChallenge({ amount: "2" });
  const base = makeTx(challenge);
  const { Amount, ...rest } = base;
  const { result } = await verifyWith(challenge, {
    ...rest,
    DeliverMax: Amount,
  });
  assert.equal(result.ok, true);
});

test("17) CAIP-2: xrpl:0 = mainnet alias; fetcher receives the canonical id", async () => {
  assert.equal(canonicalNetwork("xrpl:mainnet"), "xrpl:0");
  assert.equal(canonicalNetwork("xrpl:testnet"), "xrpl:1");
  assert.equal(canonicalNetwork("xrpl:devnet"), "xrpl:2");
  const challenge = baseChallenge({ network: "xrpl:mainnet" });
  const { result, seen } = await verifyWith(challenge, makeTx(challenge), {
    receiptNetwork: "xrpl:0",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["xrpl:0"]);
});

test("18) CAIP-2: a Testnet (xrpl:1) receipt does not satisfy a Mainnet challenge", async () => {
  const challenge = baseChallenge({ network: "xrpl:0" });
  await rejectsWith(
    "network_mismatch",
    verifyWith(challenge, makeTx(challenge), { receiptNetwork: "xrpl:1" }),
  );
});

test("19) expiry uses the ledger close time: paid in time, verified within grace => ok", async () => {
  const challenge = baseChallenge({ expiresAt: "2030-01-01T00:00:00Z" });
  const tx = makeTx(challenge, { closeTime: "2029-12-31T23:59:58Z" });
  const { result } = await verifyWith(challenge, tx, {
    now: new Date("2030-01-01T00:00:30Z"),
  });
  assert.equal(result.ok, true);
});

test("20) expiry: validated after expiresAt => expired_challenge", async () => {
  const challenge = baseChallenge({ expiresAt: "2030-01-01T00:00:00Z" });
  const tx = makeTx(challenge, { closeTime: "2030-01-01T00:00:01Z" });
  await rejectsWith(
    "expired_challenge",
    verifyWith(challenge, tx, { now: new Date("2030-01-01T00:00:10Z") }),
  );
});

test("21) expiry: presented after the grace window => expired_challenge", async () => {
  const challenge = baseChallenge({ expiresAt: "2030-01-01T00:00:00Z" });
  const tx = makeTx(challenge, { closeTime: "2029-12-31T23:59:58Z" });
  await rejectsWith(
    "expired_challenge",
    verifyWith(challenge, tx, { now: new Date("2030-01-01T00:02:00Z") }),
  );
  // A larger grace window admits it.
  const { result } = await verifyWith(challenge, tx, {
    now: new Date("2030-01-01T00:02:00Z"),
    settlementGraceSeconds: 300,
  });
  assert.equal(result.ok, true);
});

test("22) expiry without closeTime: verification time is the payment time", async () => {
  const challenge = baseChallenge({ expiresAt: "2030-01-01T00:00:00Z" });
  await rejectsWith(
    "expired_challenge",
    verifyWith(challenge, makeTx(challenge), {
      now: new Date("2030-01-01T00:00:01Z"),
    }),
  );
});

test("23) fromRippledTx maps API v2 tx results (tx_json, meta, close_time_iso)", () => {
  const tx = fromRippledTx({
    tx_json: {
      TransactionType: "Payment",
      Account: "rA",
      Destination: "rB",
      DeliverMax: "1000",
      Flags: 0,
      Signers: [{}],
    },
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000" },
    validated: true,
    hash: "H",
    ledger_index: 5,
    close_time_iso: "2026-10-10T21:16:30Z",
  });
  assert.deepEqual(
    {
      v: tx?.validated,
      t: tx?.TransactionType,
      dm: tx?.DeliverMax,
      r: tx?.meta?.TransactionResult,
      c: tx?.closeTime,
    },
    {
      v: true,
      t: "Payment",
      dm: "1000",
      r: "tesSUCCESS",
      c: "2026-10-10T21:16:30.000Z",
    },
  );
});

test("24) fromRippledTx maps API v1 tx results (inline fields, ripple-epoch date)", () => {
  const tx = fromRippledTx({
    TransactionType: "Payment",
    Account: "rA",
    Destination: "rB",
    Amount: "1000",
    date: 813446190,
    meta: { TransactionResult: "tecPATH_DRY" },
    validated: true,
  });
  assert.equal(tx?.Amount, "1000");
  assert.equal(tx?.meta?.TransactionResult, "tecPATH_DRY");
  assert.equal(
    tx?.closeTime,
    new Date((813446190 + 946684800) * 1000).toISOString(),
  );
  assert.equal(fromRippledTx(null), null);
});
