import assert from "node:assert/strict";
import test from "node:test";
import { encode, encodeForSigning } from "ripple-binary-codec";
import { sign } from "ripple-keypairs";

import {
  ExactVerificationError,
  confirmExactSettlement,
  invoiceIdToField,
  verifyExactPayload,
  type FetchAccountState,
  type XrplAccountState,
} from "../src/exact.js";
import {
  InMemoryReplayStore,
  type FetchTransaction,
  type PaymentRequirements,
  type XrplPaymentTransaction,
} from "../src/index.js";
import {
  byAccountId,
  multiSigned,
  wallet,
  type Tx,
  type Wallet,
} from "./support/multisig.js";

const LEDGER = 100;

function baseTx(from: string, to: string, over: Partial<Tx> = {}): Tx {
  return {
    TransactionType: "Payment",
    Account: from,
    Destination: to,
    Amount: "2500000",
    Fee: "20",
    Sequence: 5,
    LastLedgerSequence: LEDGER + 5,
    ...over,
  };
}
function singleSigned(tx: Tx, w: Wallet): string {
  const signing = { ...tx, SigningPubKey: w.publicKey };
  const TxnSignature = sign(encodeForSigning(signing), w.privateKey);
  return encode({ ...signing, TxnSignature });
}
const payTo = wallet().address;
const reqXrp = (extra: Record<string, unknown> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "xrpl:1",
  amount: "2500000",
  asset: "XRP",
  payTo,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: false, ...extra },
});

/** Account-state fetcher backed by a map; unknown accounts resolve to null. */
function states(map: Record<string, XrplAccountState>): FetchAccountState {
  return async (_net, account) => map[account] ?? null;
}
const funded = (over: Partial<XrplAccountState> = {}): XrplAccountState => ({
  exists: true,
  masterDisabled: false,
  regularKey: null,
  sequence: 5,
  ...over,
});

async function rejects(code: string, p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => {
    assert(e instanceof ExactVerificationError, String(e));
    assert.equal(e.code, code);
    return true;
  });
}

// ── single-signed ────────────────────────────────────────────────────────────

test("single-signed valid payment verifies", async () => {
  const payer = wallet();
  const blob = singleSigned(baseTx(payer.address, payTo), payer);
  const r = await verifyExactPayload({
    requirements: reqXrp(),
    payload: { signedTxBlob: blob },
    fetchAccountState: states({ [payer.address]: funded() }),
    validatedLedgerIndex: LEDGER,
    feePolicyDrops: "1000",
  });
  assert.equal(r.ok, true);
  assert.equal(r.account, payer.address);
  assert.equal(r.multisig, false);
});

test("tampered after signing (fee bumped) → signature_invalid", async () => {
  const payer = wallet();
  const blob = singleSigned(baseTx(payer.address, payTo), payer);
  // Re-decode, bump the fee, re-encode without re-signing.
  const { decode } = await import("ripple-binary-codec");
  const tampered = encode({ ...(decode(blob) as Tx), Fee: "21" });
  await rejects(
    "signature_invalid",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: tampered },
      fetchAccountState: states({ [payer.address]: funded() }),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("signed by a key that does not control the account → signer_not_authorized", async () => {
  const payer = wallet();
  const stranger = wallet();
  // Valid signature, but SigningPubKey is the stranger's and payer has no matching regular key.
  const blob = singleSigned(baseTx(payer.address, payTo), stranger);
  await rejects(
    "signer_not_authorized",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states({ [payer.address]: funded() }),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("regular key is accepted", async () => {
  const payer = wallet();
  const regular = wallet();
  const blob = singleSigned(baseTx(payer.address, payTo), regular);
  const r = await verifyExactPayload({
    requirements: reqXrp(),
    payload: { signedTxBlob: blob },
    fetchAccountState: states({
      [payer.address]: funded({ regularKey: regular.address }),
    }),
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(r.ok, true);
});

// ── multisig (engagement-account shape) ───────────────────────────────────────

// a1 sorts before a2 by account ID, so [a1, a2] is a valid Signers order.
const [a1, a2] = [wallet(), wallet()].sort(byAccountId);
const eng = wallet(); // engagement account: master disabled, 2-of-2 SignerList
const engState = (): Record<string, XrplAccountState> => ({
  [eng.address]: funded({
    masterDisabled: true,
    signerList: {
      quorum: 2,
      signers: [
        { account: a1.address, weight: 1 },
        { account: a2.address, weight: 1 },
      ],
    },
  }),
  [a1.address]: funded(),
  [a2.address]: funded(),
});
function engTx(over: Partial<Tx> = {}): Tx {
  return baseTx(eng.address, payTo, over);
}

test("multisig at quorum verifies", async () => {
  const map = engState();
  const blob = multiSigned(engTx(), [a1, a2]);
  const r = await verifyExactPayload({
    requirements: reqXrp(),
    payload: { signedTxBlob: blob },
    fetchAccountState: states(map),
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(r.ok, true);
  assert.equal(r.multisig, true);
});

test("below quorum → multisig_quorum_not_met", async () => {
  const map = engState();
  const blob = multiSigned(engTx(), [a1]);
  await rejects(
    "multisig_quorum_not_met",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("signer not on the SignerList → multisig_signer_not_authorized", async () => {
  const map = engState();
  const outsider = wallet();
  map[outsider.address] = funded();
  const blob = multiSigned(engTx(), [a1, outsider]);
  await rejects(
    "multisig_signer_not_authorized",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("multisig tampered after signing → multisig_signature_invalid", async () => {
  const map = engState();
  const { decode } = await import("ripple-binary-codec");
  const good = multiSigned(engTx(), [a1, a2]);
  const tampered = encode({ ...(decode(good) as Tx), Fee: "21" });
  await rejects(
    "multisig_signature_invalid",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: tampered },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("no valid signer at all → multisig_signer_not_authorized", async () => {
  const map = engState();
  const x = wallet();
  const y = wallet();
  map[x.address] = funded();
  map[y.address] = funded();
  const blob = multiSigned(engTx(), [x, y]);
  await rejects(
    "multisig_signer_not_authorized",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("multisig payer not on ledger → multisig_account_not_found", async () => {
  const map = engState();
  delete map[eng.address];
  const blob = multiSigned(engTx(), [a1, a2]);
  await rejects(
    "multisig_account_not_found",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("duplicate multisig signer → multisig_signer_not_authorized", async () => {
  const map = engState();
  const blob = multiSigned(engTx(), [a1, a1]);
  await rejects(
    "multisig_signer_not_authorized",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("listed signer using a disabled master key → multisig_signer_not_authorized", async () => {
  const map = engState();
  map[a2.address] = funded({ masterDisabled: true });
  const blob = multiSigned(engTx(), [a1, a2]);
  await rejects(
    "multisig_signer_not_authorized",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("multisig signer account lookups run concurrently", async () => {
  const map = engState();
  const base = states(map);
  const signerAccounts = new Set([a1.address, a2.address]);
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchAccountState: FetchAccountState = async (net, account) => {
    if (!signerAccounts.has(account)) return base(net, account);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    return base(net, account);
  };
  const r = await verifyExactPayload({
    requirements: reqXrp(),
    payload: { signedTxBlob: multiSigned(engTx(), [a1, a2]) },
    fetchAccountState,
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(r.ok, true);
  assert.ok(maxInFlight >= 2, `max in flight: ${maxInFlight}`);
});

test("several unauthorized signers → error names the first in signer order", async () => {
  const map = engState();
  map[a1.address] = funded({ masterDisabled: true });
  map[a2.address] = funded({ masterDisabled: true });
  const base = states(map);
  // a1's lookup resolves last, so its failure settles after a2's.
  const fetchAccountState: FetchAccountState = async (net, account) => {
    if (account === a1.address) await new Promise((r) => setTimeout(r, 20));
    return base(net, account);
  };
  await assert.rejects(
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: multiSigned(engTx(), [a1, a2]) },
      fetchAccountState,
      validatedLedgerIndex: LEDGER,
    }),
    (e: unknown) => {
      assert(e instanceof ExactVerificationError, String(e));
      assert.equal(e.code, "multisig_signer_not_authorized");
      assert.match(e.message, new RegExp(a1.address));
      return true;
    },
  );
});

test(
  "unauthorized signer fails without waiting for later lookups",
  { timeout: 2000 },
  async () => {
    const map = engState();
    map[a1.address] = funded({ masterDisabled: true });
    const base = states(map);
    // a2's lookup never settles; verification must still reject on a1.
    const fetchAccountState: FetchAccountState = async (net, account) => {
      if (account === a2.address) return new Promise(() => {});
      return base(net, account);
    };
    await rejects(
      "multisig_signer_not_authorized",
      verifyExactPayload({
        requirements: reqXrp(),
        payload: { signedTxBlob: multiSigned(engTx(), [a1, a2]) },
        fetchAccountState,
        validatedLedgerIndex: LEDGER,
      }),
    );
  },
);

test("below quorum → rejected before any signer lookup", async () => {
  const map = engState();
  const base = states(map);
  const looked: string[] = [];
  const fetchAccountState: FetchAccountState = async (net, account) => {
    if (account !== eng.address) looked.push(account);
    return base(net, account);
  };
  await rejects(
    "multisig_quorum_not_met",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: multiSigned(engTx(), [a1]) },
      fetchAccountState,
      validatedLedgerIndex: LEDGER,
    }),
  );
  assert.deepEqual(looked, []);
});

test("Signers not sorted by account ID → invalid_transaction", async () => {
  const map = engState();
  const blob = multiSigned(engTx(), [a2, a1], { keepOrder: true });
  await rejects(
    "invalid_transaction",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("Signers order is by account ID, not by address string", async () => {
  // Fixed test-only seeds: as strings rMwCk… < rpvva…, but by account ID
  // rpvva… comes first. Comparing address strings would get this backwards.
  const m = wallet("sEdSJHS4oiAdz7w2X2ni1gFiihccMfL"); // rMwCk9x2…
  const p = wallet("sEdSJHS4oiAdz7w2X2ni1gFiiN7Jpvj"); // rpvvavrQ…
  assert.ok(m.address < p.address);
  const map = engState();
  map[eng.address].signerList = {
    quorum: 2,
    signers: [
      { account: m.address, weight: 1 },
      { account: p.address, weight: 1 },
    ],
  };
  map[m.address] = funded();
  map[p.address] = funded();
  const verify = (blob: string) =>
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    });
  const r = await verify(multiSigned(engTx(), [p, m], { keepOrder: true }));
  assert.equal(r.ok, true);
  await rejects(
    "invalid_transaction",
    verify(multiSigned(engTx(), [m, p], { keepOrder: true })),
  );
});

test("Signers order is checked before any signature", async () => {
  // Out of order AND every signature broken (Fee changed after signing): the
  // structural error must win, so no signature work is done on such a blob.
  const map = engState();
  const { decode } = await import("ripple-binary-codec");
  const unsorted = multiSigned(engTx(), [a2, a1], { keepOrder: true });
  const tampered = encode({ ...(decode(unsorted) as Tx), Fee: "21" });
  await rejects(
    "invalid_transaction",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: tampered },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("more than 32 signers → invalid_transaction", async () => {
  const map = engState();
  const many = Array.from({ length: 33 }, () => wallet());
  await rejects(
    "invalid_transaction",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: multiSigned(engTx(), many) },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("payer signing its own multisig → invalid_transaction", async () => {
  const map = engState();
  // Even if the payer appears on its own SignerList, it may not sign.
  map[eng.address].signerList!.signers.push({
    account: eng.address,
    weight: 1,
  });
  const blob = multiSigned(engTx(), [eng, a1]);
  await assert.rejects(
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: blob },
      fetchAccountState: states(map),
      validatedLedgerIndex: LEDGER,
    }),
    (e: unknown) => {
      assert(e instanceof ExactVerificationError, String(e));
      assert.equal(e.code, "invalid_transaction");
      assert.match(e.message, /payer account/);
      return true;
    },
  );
});

// ── field checks ──────────────────────────────────────────────────────────────

test("destination / amount / forbidden-field / invoice / expiry / fee checks", async () => {
  const payer = wallet();
  const st = states({ [payer.address]: funded() });
  const v = (
    tx: Tx,
    req = reqXrp(),
    ledger: number | undefined = LEDGER,
    fee?: string,
  ) =>
    verifyExactPayload({
      requirements: req,
      payload: { signedTxBlob: singleSigned(tx, payer) },
      fetchAccountState: st,
      validatedLedgerIndex: ledger,
      feePolicyDrops: fee,
    });

  await rejects(
    "destination_mismatch",
    v(baseTx(payer.address, wallet().address)),
  );
  await rejects(
    "amount_mismatch",
    v(baseTx(payer.address, payTo, { Amount: "2400000" })),
  );
  await rejects(
    "asset_mismatch",
    v(
      baseTx(payer.address, payTo, {
        Amount: { currency: "USD", issuer: payer.address, value: "2.5" },
      }),
    ),
  );
  await rejects(
    "forbidden_field",
    v(baseTx(payer.address, payTo, { Memos: [{ Memo: { MemoData: "AA" } }] })),
  );
  await rejects(
    "forbidden_field",
    v(baseTx(payer.address, payTo, { Flags: 0x00020000 })),
  );
  await rejects(
    "expiry_invalid",
    v(baseTx(payer.address, payTo, { LastLedgerSequence: undefined })),
  );
  await rejects(
    "expiry_invalid",
    v(baseTx(payer.address, payTo, { LastLedgerSequence: LEDGER + 10_000 })),
  );
  await rejects(
    "fee_too_high",
    v(baseTx(payer.address, payTo, { Fee: "5000" }), reqXrp(), LEDGER, "1000"),
  );

  // InvoiceID binding
  const inv = "inv-xyz";
  await rejects(
    "invoice_mismatch",
    v(baseTx(payer.address, payTo), reqXrp({ invoiceId: inv })),
  );
  const okBlob = singleSigned(
    baseTx(payer.address, payTo, { InvoiceID: invoiceIdToField(inv) }),
    payer,
  );
  const ok = await verifyExactPayload({
    requirements: reqXrp({ invoiceId: inv }),
    payload: { signedTxBlob: okBlob },
    fetchAccountState: st,
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(ok.ok, true);
});

test("ticketSequence mode: Sequence 0 and a known ticket", async () => {
  const payer = wallet();
  const req = reqXrp({ assetTransferMethod: "ticketSequence" });
  const blob = singleSigned(
    baseTx(payer.address, payTo, { Sequence: 0, TicketSequence: 77 }),
    payer,
  );
  const r = await verifyExactPayload({
    requirements: req,
    payload: { signedTxBlob: blob },
    fetchAccountState: states({ [payer.address]: funded({ tickets: [77] }) }),
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(r.ok, true);
  const bad = singleSigned(
    baseTx(payer.address, payTo, { Sequence: 0, TicketSequence: 78 }),
    payer,
  );
  await rejects(
    "sequencing_invalid",
    verifyExactPayload({
      requirements: req,
      payload: { signedTxBlob: bad },
      fetchAccountState: states({ [payer.address]: funded({ tickets: [77] }) }),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("IOU exact payment verifies and enforces issuer", async () => {
  const payer = wallet();
  const issuer = wallet().address;
  const req: PaymentRequirements = {
    scheme: "exact",
    network: "xrpl:1",
    amount: "10.25",
    asset: "USD",
    payTo,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: false, issuer },
  };
  const good = singleSigned(
    baseTx(payer.address, payTo, {
      Amount: { currency: "USD", issuer, value: "10.25" },
    }),
    payer,
  );
  const r = await verifyExactPayload({
    requirements: req,
    payload: { signedTxBlob: good },
    fetchAccountState: states({ [payer.address]: funded() }),
    validatedLedgerIndex: LEDGER,
  });
  assert.equal(r.ok, true);
  const wrongIssuer = singleSigned(
    baseTx(payer.address, payTo, {
      Amount: { currency: "USD", issuer: wallet().address, value: "10.25" },
    }),
    payer,
  );
  await rejects(
    "asset_mismatch",
    verifyExactPayload({
      requirements: req,
      payload: { signedTxBlob: wrongIssuer },
      fetchAccountState: states({ [payer.address]: funded() }),
      validatedLedgerIndex: LEDGER,
    }),
  );
});

test("invalid payload / undecodable blob", async () => {
  await rejects(
    "invalid_payload",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: {},
      fetchAccountState: states({}),
    }),
  );
  await rejects(
    "invalid_transaction",
    verifyExactPayload({
      requirements: reqXrp(),
      payload: { signedTxBlob: "ZZZZ" },
      fetchAccountState: states({}),
    }),
  );
});

// ── confirmExactSettlement ─────────────────────────────────────────────────────

function fetchTx(
  map: Record<string, XrplPaymentTransaction>,
): FetchTransaction {
  return async (_net, hash) => map[hash] ?? null;
}
const settledTx = (
  over: Partial<XrplPaymentTransaction> = {},
): XrplPaymentTransaction => ({
  validated: true,
  TransactionType: "Payment",
  Account: "rPAYER",
  Destination: payTo,
  Amount: "2500000",
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "2500000" },
  ...over,
});

test("confirm: tesSUCCESS settles; replay is idempotent", async () => {
  const store = new InMemoryReplayStore();
  const params = {
    requirements: reqXrp({ invoiceId: "inv-9" }),
    txHash: "TX1",
    fetchTransaction: fetchTx({
      TX1: settledTx({ InvoiceID: invoiceIdToField("inv-9") }),
    }),
    replayStore: store,
  };
  const first = await confirmExactSettlement(params);
  assert.equal(first.idempotent, false);
  assert.equal(first.payerAccount, "rPAYER");
  const second = await confirmExactSettlement(params);
  assert.equal(second.idempotent, true);
});

test("confirm: tec result → tx_failed", async () => {
  await rejects(
    "tx_failed",
    confirmExactSettlement({
      requirements: reqXrp(),
      txHash: "TXF",
      fetchTransaction: fetchTx({
        TXF: settledTx({
          meta: {
            TransactionResult: "tecUNFUNDED_PAYMENT",
            delivered_amount: "0",
          },
        }),
      }),
      replayStore: new InMemoryReplayStore(),
    }),
  );
});

test("confirm: delivered amount mismatch → amount_mismatch", async () => {
  await rejects(
    "amount_mismatch",
    confirmExactSettlement({
      requirements: reqXrp(),
      txHash: "TXD",
      fetchTransaction: fetchTx({
        TXD: settledTx({
          meta: {
            TransactionResult: "tesSUCCESS",
            delivered_amount: "2400000",
          },
        }),
      }),
      replayStore: new InMemoryReplayStore(),
    }),
  );
});

test("confirm: same txHash with a different paymentId → replay_detected", async () => {
  const store = new InMemoryReplayStore();
  await confirmExactSettlement({
    requirements: reqXrp(),
    txHash: "TXR",
    paymentId: "A",
    fetchTransaction: fetchTx({ TXR: settledTx() }),
    replayStore: store,
  });
  await rejects(
    "replay_detected",
    confirmExactSettlement({
      requirements: reqXrp(),
      txHash: "TXR",
      paymentId: "B",
      fetchTransaction: fetchTx({ TXR: settledTx() }),
      replayStore: store,
    }),
  );
});
