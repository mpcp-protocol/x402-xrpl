import assert from "node:assert/strict";
import test from "node:test";

import {
  EnvelopeError,
  createChallenge,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
  toPaymentRequirements,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "../src/index.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "xrpl:1",
  amount: "2500000",
  asset: "XRP",
  payTo: "rDEST",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: false, invoiceId: "inv-1" },
};

test("PAYMENT-REQUIRED round-trips", () => {
  const required: PaymentRequired = {
    x402Version: 2,
    resource: "https://api.example/report",
    accepts: [requirements],
  };
  const decoded = decodePaymentRequiredHeader(
    encodePaymentRequiredHeader(required),
  );
  assert.deepEqual(decoded, required);
});

test("PAYMENT-SIGNATURE round-trips", () => {
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { signedTxBlob: "1200..." },
  };
  const decoded = decodePaymentSignatureHeader(
    encodePaymentSignatureHeader(payload),
  );
  assert.deepEqual(decoded, payload);
});

test("PAYMENT-RESPONSE round-trips", () => {
  const response: SettlementResponse = {
    success: true,
    transaction: "ABCDEF",
    network: "xrpl:1",
    payer: "rPAYER",
    amount: "2500000",
  };
  const decoded = decodePaymentResponseHeader(
    encodePaymentResponseHeader(response),
  );
  assert.deepEqual(decoded, response);
});

test("rejects non-base64 / non-JSON", () => {
  assert.throws(
    () => decodePaymentRequiredHeader("@@@not base64@@@"),
    EnvelopeError,
  );
  assert.throws(
    () =>
      decodePaymentSignatureHeader(
        Buffer.from("not json", "utf8").toString("base64"),
      ),
    EnvelopeError,
  );
});

test("rejects wrong x402Version and missing fields", () => {
  const bad = Buffer.from(
    JSON.stringify({ x402Version: 1, resource: "r", accepts: [requirements] }),
    "utf8",
  ).toString("base64");
  assert.throws(
    () => decodePaymentRequiredHeader(bad),
    /x402Version must be 2/,
  );
  const noAccepts = Buffer.from(
    JSON.stringify({ x402Version: 2, resource: "r", accepts: [] }),
    "utf8",
  ).toString("base64");
  assert.throws(
    () => decodePaymentRequiredHeader(noAccepts),
    /non-empty array/,
  );
  const badReq = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: "r",
      accepts: [
        {
          scheme: "exact",
          network: "xrpl:1",
          amount: "1",
          asset: "XRP",
          payTo: "rD",
        },
      ],
    }),
    "utf8",
  ).toString("base64");
  assert.throws(() => decodePaymentRequiredHeader(badReq), /maxTimeoutSeconds/);
});

test("toPaymentRequirements: XRP → drops, IOU → decimal + issuer", () => {
  const xrp = toPaymentRequirements(
    createChallenge({
      network: "xrpl:1",
      amount: "2.5",
      asset: { kind: "XRP" },
      destination: "rDEST",
      expiresAt: "2099-01-01T00:00:00Z",
      paymentId: "P1",
    }),
    {
      scheme: "exact",
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: false, invoiceId: "P1" },
    },
  );
  assert.equal(xrp.amount, "2500000");
  assert.equal(xrp.asset, "XRP");
  assert.deepEqual(xrp.extra, { areFeesSponsored: false, invoiceId: "P1" });

  const iou = toPaymentRequirements(
    createChallenge({
      network: "xrpl:0",
      amount: "10.25",
      asset: { kind: "IOU", currency: "RLUSD", issuer: "rISSUER" },
      destination: "rDEST",
      expiresAt: "2099-01-01T00:00:00Z",
      paymentId: "P2",
    }),
    { scheme: "exact", maxTimeoutSeconds: 120 },
  );
  assert.equal(iou.amount, "10.25");
  assert.equal(iou.asset, "RLUSD");
  assert.equal(iou.extra?.issuer, "rISSUER");
});
