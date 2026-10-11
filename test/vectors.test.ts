import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  InMemoryReplayStore,
  SettlementVerificationError,
  createChallenge,
  encodeReceiptHeader,
  verifySettlement,
  type FetchTransaction,
  type XrplNetwork,
  type XrplPaymentTransaction,
} from "../src/index.js";

interface VectorStep {
  receipt?: { network: string; txHash: string; paymentId: string };
  receiptRaw?: string;
  txByHash: Record<string, XrplPaymentTransaction & { memoPaymentId?: string }>;
  expect: { ok?: boolean; idempotent?: boolean; errorCode?: string };
  /** Verification time (ISO-8601); defaults to the real clock. */
  now?: string;
}

interface VectorCase {
  id: string;
  description: string;
  challenge: {
    network: XrplNetwork;
    amount: string;
    asset: { kind: "XRP" } | { kind: "IOU"; currency: string; issuer: string };
    destination: string;
    expiresAt: string;
    paymentId: string;
  };
  steps: VectorStep[];
}

function utf8ToHex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function memoForPaymentId(paymentId: string) {
  const memoData = { v: 1, t: "x402", paymentId };
  return [
    {
      Memo: {
        MemoType: utf8ToHex("x402"),
        MemoFormat: utf8ToHex("application/json"),
        MemoData: utf8ToHex(JSON.stringify(memoData)),
      },
    },
  ];
}

function enrichTx(tx: XrplPaymentTransaction & { memoPaymentId?: string }): XrplPaymentTransaction {
  if (tx.memoPaymentId === undefined) {
    return tx;
  }
  return {
    ...tx,
    Memos: memoForPaymentId(tx.memoPaymentId),
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const vectorsPath = path.resolve(__dirname, "..", "conformance", "test_vectors.json");
const vectorsDoc = JSON.parse(await readFile(vectorsPath, "utf-8")) as {
  version: string;
  cases: VectorCase[];
};

test("shared conformance vectors", async () => {
  assert.equal(vectorsDoc.version, "2");

  for (const vector of vectorsDoc.cases) {
    const challenge = createChallenge({
      ...vector.challenge,
      expiresAt: vector.challenge.expiresAt,
      paymentId: vector.challenge.paymentId,
    });
    const replayStore = new InMemoryReplayStore();

    for (const step of vector.steps) {
      const fetchTransaction: FetchTransaction = async (_network, txHash) => {
        const tx = step.txByHash[txHash];
        return tx === undefined ? null : enrichTx(tx);
      };

      const receiptHeaderValue =
        step.receiptRaw ??
        encodeReceiptHeader({
          network: step.receipt!.network as XrplNetwork,
          txHash: step.receipt!.txHash,
          paymentId: step.receipt!.paymentId,
        });

      if (step.expect.errorCode !== undefined) {
        await assert.rejects(
          () =>
            verifySettlement({
              challenge,
              receiptHeaderValue,
              fetchTransaction,
              replayStore,
              now: step.now !== undefined ? new Date(step.now) : undefined,
            }),
          (error: unknown) => {
            assert(error instanceof SettlementVerificationError);
            assert.equal(error.code, step.expect.errorCode, `${vector.id}: ${vector.description}`);
            return true;
          },
        );
        continue;
      }

      const result = await verifySettlement({
        challenge,
        receiptHeaderValue,
        fetchTransaction,
        replayStore,
        now: step.now !== undefined ? new Date(step.now) : undefined,
      });
      assert.equal(result.ok, step.expect.ok ?? true, `${vector.id}: ${vector.description}`);
      assert.equal(
        result.idempotent,
        step.expect.idempotent ?? false,
        `${vector.id}: ${vector.description}`,
      );
    }
  }
});
