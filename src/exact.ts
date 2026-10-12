/**
 * The x402 XRPL `exact` scheme: the client sends a presigned `Payment` blob
 * (`payload.signedTxBlob`), the server verifies it fully **offline** — including
 * signatures and multisig quorum against the payer's on-ledger SignerList — and
 * only then submits it. Interoperable with other x402 XRPL `exact` clients.
 *
 * Why the offline signature check matters: a facilitator that returns `valid`
 * from `/verify` without checking signatures can be made to report a payment as
 * good when the ledger will reject it at submission (wrong/absent signatures,
 * below quorum, signer not on the SignerList). A merchant that serves on
 * `/verify` would then deliver for nothing. {@link verifyExactPayload} refuses
 * all of those. `simulate` cannot catch them because signature fields are
 * stripped before simulation.
 */
import { createHash } from "node:crypto";
import {
  decode,
  encodeForSigning,
  encodeForMultisigning,
} from "ripple-binary-codec";
import { verify as kpVerify, deriveAddress } from "ripple-keypairs";
import { canonicalNetwork } from "./index.js";
import type { PaymentRequirements } from "./envelope.js";

export type ExactErrorCode =
  | "invalid_payload"
  | "invalid_transaction"
  | "wrong_transaction_type"
  | "destination_mismatch"
  | "amount_mismatch"
  | "asset_mismatch"
  | "forbidden_field"
  | "invoice_mismatch"
  | "destination_tag_mismatch"
  | "sequencing_invalid"
  | "expiry_invalid"
  | "fee_too_high"
  | "signature_invalid"
  | "signer_not_authorized"
  | "quorum_not_met"
  | "account_not_found"
  | "tx_failed"
  | "replay_detected";

export class ExactVerificationError extends Error {
  readonly code: ExactErrorCode;
  constructor(code: ExactErrorCode, message: string) {
    super(message);
    this.name = "ExactVerificationError";
    this.code = code;
  }
}

export interface XrplSignerEntry {
  account: string;
  weight: number;
}

export interface XrplSignerList {
  quorum: number;
  signers: XrplSignerEntry[];
}

/** Account state at a validated ledger, needed to authorize signatures. */
export interface XrplAccountState {
  exists: boolean;
  /** Next account sequence; when present, `assetTransferMethod: "sequence"` requires the tx to match it. */
  sequence?: number;
  masterDisabled?: boolean;
  regularKey?: string | null;
  signerList?: XrplSignerList | null;
  /** Available ticket sequences; when present, `ticketSequence` must reference one. */
  tickets?: number[];
}

export type FetchAccountState = (
  network: string,
  account: string,
) => Promise<XrplAccountState | null>;

const PARTIAL_PAYMENT_FLAG = 0x00020000;

export interface VerifyExactParams {
  requirements: PaymentRequirements;
  /** The `payload` object from the PaymentPayload; must contain `signedTxBlob`. */
  payload: Record<string, unknown>;
  /** Reads payer and signer account state at the latest validated ledger. */
  fetchAccountState: FetchAccountState;
  /** Latest validated ledger index; enables the `LastLedgerSequence` upper-bound check. */
  validatedLedgerIndex?: number;
  /** Max fee the facilitator will accept, in drops. */
  feePolicyDrops?: string;
}

export interface VerifyExactResult {
  ok: true;
  /** Payer (transaction Account). */
  account: string;
  /** Decoded transaction. */
  transaction: Record<string, unknown>;
  /** Hex of the signed blob (as provided). */
  signedTxBlob: string;
  multisig: boolean;
}

function fail(code: ExactErrorCode, message: string): never {
  throw new ExactVerificationError(code, message);
}

/** Normalise an XRPL currency code for comparison (ISO 3-char kept; others → 40-char hex). */
function normalizeCurrency(code: string): string {
  const c = code.trim();
  if (c.length === 3) return c.toUpperCase();
  if (/^[0-9A-Fa-f]{40}$/.test(c)) return c.toUpperCase();
  return Buffer.from(c, "ascii").toString("hex").toUpperCase().padEnd(40, "0");
}

/** SHA-256 of a UTF-8 string, uppercase hex (XRPL InvoiceID form). */
export function invoiceIdToField(invoiceId: string): string {
  return createHash("sha256")
    .update(invoiceId, "utf8")
    .digest("hex")
    .toUpperCase();
}

type XrplAmount =
  | string
  | { currency?: unknown; issuer?: unknown; value?: unknown };

/** True when an XRPL Amount matches the requirements (atomic units). Never throws. */
function amountMatches(
  requirements: PaymentRequirements,
  amount: XrplAmount | undefined,
): { ok: boolean; reason?: ExactErrorCode } {
  if (requirements.asset === "XRP") {
    if (typeof amount !== "string")
      return { ok: false, reason: "asset_mismatch" };
    return { ok: amount === requirements.amount, reason: "amount_mismatch" };
  }
  if (typeof amount !== "object" || amount === null)
    return { ok: false, reason: "asset_mismatch" };
  const issuer =
    (requirements.extra?.issuer as string | undefined) ?? undefined;
  if (issuer === undefined) return { ok: false, reason: "asset_mismatch" };
  if (
    typeof amount.currency !== "string" ||
    typeof amount.issuer !== "string" ||
    typeof amount.value !== "string"
  ) {
    return { ok: false, reason: "asset_mismatch" };
  }
  if (
    normalizeCurrency(amount.currency) !==
      normalizeCurrency(requirements.asset) ||
    amount.issuer !== issuer
  ) {
    return { ok: false, reason: "asset_mismatch" };
  }
  return {
    ok: amount.value === requirements.amount,
    reason: "amount_mismatch",
  };
}

/**
 * Verify a presigned `exact` payment offline, against the payer's state at the
 * latest validated ledger. Returns on success; throws {@link ExactVerificationError}
 * otherwise. Does NOT submit; call {@link confirmExactSettlement} after the
 * caller submits the returned `signedTxBlob`.
 */
export async function verifyExactPayload(
  params: VerifyExactParams,
): Promise<VerifyExactResult> {
  const { requirements, payload } = params;
  const network = canonicalNetwork(requirements.network as never);
  const blob = payload.signedTxBlob;
  if (typeof blob !== "string" || blob.length === 0) {
    fail("invalid_payload", "payload.signedTxBlob is required");
  }

  let tx: Record<string, unknown>;
  try {
    tx = decode(blob as string) as Record<string, unknown>;
  } catch {
    return fail(
      "invalid_transaction",
      "signedTxBlob is not a decodable XRPL transaction",
    );
  }

  if (tx.TransactionType !== "Payment")
    fail("wrong_transaction_type", "transaction is not a Payment");
  const account = tx.Account;
  if (typeof account !== "string" || account.length === 0)
    fail("invalid_transaction", "Account is required");
  if (tx.Destination !== requirements.payTo)
    fail("destination_mismatch", "Destination does not match payTo");

  // A signed blob is XRPL binary, so the delivered amount is always `Amount`
  // (`DeliverMax` is an API v2 JSON alias that never appears in a blob).
  if (tx.Amount === undefined) fail("forbidden_field", "Amount is required");
  const m = amountMatches(requirements, tx.Amount as XrplAmount);
  if (!m.ok) fail(m.reason!, `amount/asset does not match requirements`);

  // Forbidden fields (x402 XRPL exact §9).
  if (tx.Memos !== undefined)
    fail("forbidden_field", "Memos are not allowed in the exact scheme");
  if (tx.Delegate !== undefined)
    fail("forbidden_field", "Delegate is not allowed");
  if (tx.Paths !== undefined) fail("forbidden_field", "Paths are not allowed");
  if (tx.DeliverMin !== undefined)
    fail("forbidden_field", "DeliverMin is not allowed");
  if ((Number(tx.Flags ?? 0) & PARTIAL_PAYMENT_FLAG) !== 0)
    fail("forbidden_field", "tfPartialPayment is not allowed");
  if (tx.SendMax !== undefined) {
    if (requirements.asset === "XRP")
      fail("forbidden_field", "SendMax is not allowed for XRP payments");
    // For an IOU, SendMax may only equal the delivered amount (no path-based over-spend).
    const sm = amountMatches(requirements, tx.SendMax as XrplAmount);
    if (!sm.ok)
      fail("forbidden_field", "SendMax must equal the exact IOU amount");
  }

  // DestinationTag: must match when the requirements pin one.
  const requiredTag = requirements.extra?.destinationTag;
  if (
    requiredTag !== undefined &&
    Number(tx.DestinationTag) !== Number(requiredTag)
  ) {
    fail(
      "destination_tag_mismatch",
      "DestinationTag does not match requirements",
    );
  }

  // Invoice binding (InvoiceID = SHA-256(invoiceId), uppercase hex).
  const invoiceId = requirements.extra?.invoiceId;
  if (invoiceId !== undefined) {
    if (typeof invoiceId !== "string" || invoiceId.length === 0)
      fail("invalid_payload", "extra.invoiceId must be a non-empty string");
    if (
      typeof tx.InvoiceID !== "string" ||
      (tx.InvoiceID as string).toUpperCase() !== invoiceIdToField(invoiceId)
    ) {
      fail(
        "invoice_mismatch",
        "InvoiceID does not bind to the required invoiceId",
      );
    }
  }

  // Expiry is ledger-based: LastLedgerSequence must be present and within range.
  const lls = tx.LastLedgerSequence;
  if (typeof lls !== "number")
    fail("expiry_invalid", "LastLedgerSequence is required");
  if (params.validatedLedgerIndex !== undefined) {
    const window = Math.ceil(requirements.maxTimeoutSeconds / 5) + 2;
    if (lls < params.validatedLedgerIndex)
      fail("expiry_invalid", "LastLedgerSequence has already passed");
    if (lls > params.validatedLedgerIndex + window)
      fail("expiry_invalid", "LastLedgerSequence is too far in the future");
  }

  if (params.feePolicyDrops !== undefined) {
    let fee: bigint;
    try {
      fee = BigInt(String(tx.Fee));
    } catch {
      return fail("invalid_transaction", "Fee is not an integer drops string");
    }
    if (fee > BigInt(params.feePolicyDrops))
      fail("fee_too_high", "Fee exceeds the facilitator policy");
  }

  // Sequencing.
  const method =
    (requirements.extra?.assetTransferMethod as string | undefined) ??
    "sequence";
  const payer = await params.fetchAccountState(network, account);
  if (method === "ticketSequence") {
    if (Number(tx.Sequence) !== 0)
      fail("sequencing_invalid", "Sequence must be 0 when using a ticket");
    if (typeof tx.TicketSequence !== "number")
      fail("sequencing_invalid", "TicketSequence is required");
    if (payer?.tickets && !payer.tickets.includes(Number(tx.TicketSequence))) {
      fail("sequencing_invalid", "TicketSequence is not an available ticket");
    }
  } else {
    if (tx.TicketSequence !== undefined)
      fail(
        "sequencing_invalid",
        "TicketSequence is not allowed in sequence mode",
      );
    if (
      payer?.sequence !== undefined &&
      Number(tx.Sequence) !== payer.sequence
    ) {
      fail(
        "sequencing_invalid",
        "Sequence does not match the account sequence",
      );
    }
  }

  // Signatures — the part a correct facilitator must not skip.
  const signers = tx.Signers as
    | Array<{
        Signer?: {
          Account?: unknown;
          SigningPubKey?: unknown;
          TxnSignature?: unknown;
        };
      }>
    | undefined;
  const multisig = Array.isArray(signers) && signers.length > 0;

  if (multisig) {
    if (typeof tx.SigningPubKey === "string" && tx.SigningPubKey.length > 0) {
      fail(
        "invalid_transaction",
        "SigningPubKey must be empty for a multisigned transaction",
      );
    }
    if (!payer || !payer.exists)
      fail("account_not_found", "payer account not found on ledger");
    if (!payer.signerList || payer.signerList.signers.length === 0) {
      fail(
        "signer_not_authorized",
        "payer has no SignerList; multisig not authorized",
      );
    }
    const weights = new Map(
      payer.signerList.signers.map((s) => [s.account, s.weight]),
    );
    const forMulti: Record<string, unknown> = { ...tx, SigningPubKey: "" };
    delete forMulti.Signers;
    delete forMulti.TxnSignature;
    const seen = new Set<string>();
    let total = 0;
    for (const entry of signers!) {
      const s = entry.Signer;
      const sa = s?.Account;
      const pub = s?.SigningPubKey;
      const sig = s?.TxnSignature;
      if (
        typeof sa !== "string" ||
        typeof pub !== "string" ||
        typeof sig !== "string"
      ) {
        fail("signature_invalid", "malformed Signer entry");
      }
      if (seen.has(sa)) fail("signer_not_authorized", "duplicate signer");
      seen.add(sa);
      const weight = weights.get(sa);
      if (weight === undefined)
        fail("signer_not_authorized", `signer ${sa} is not on the SignerList`);
      let valid = false;
      try {
        valid = kpVerify(
          encodeForMultisigning(forMulti as never, sa),
          sig,
          pub,
        );
      } catch {
        valid = false;
      }
      if (!valid) fail("signature_invalid", `invalid signature from ${sa}`);
      await assertSigningKeyAuthorized(
        params.fetchAccountState,
        network,
        sa,
        pub,
      );
      total += weight;
    }
    if (total < payer.signerList.quorum)
      fail("quorum_not_met", "signer weights below quorum");
  } else {
    const pub = tx.SigningPubKey;
    const sig = tx.TxnSignature;
    if (
      typeof pub !== "string" ||
      pub.length === 0 ||
      typeof sig !== "string" ||
      sig.length === 0
    ) {
      fail(
        "signature_invalid",
        "single-signed transaction requires SigningPubKey and TxnSignature",
      );
    }
    const forSigning: Record<string, unknown> = { ...tx };
    delete forSigning.TxnSignature;
    let valid = false;
    try {
      valid = kpVerify(encodeForSigning(forSigning as never), sig, pub);
    } catch {
      valid = false;
    }
    if (!valid) fail("signature_invalid", "invalid transaction signature");
    await assertSigningKeyAuthorized(
      params.fetchAccountState,
      network,
      account,
      pub,
      payer,
    );
  }

  return {
    ok: true,
    account,
    transaction: tx,
    signedTxBlob: blob as string,
    multisig,
  };
}

/** A signing key authorizes an account iff it is the account's (enabled) master key or its regular key. */
async function assertSigningKeyAuthorized(
  fetchAccountState: FetchAccountState,
  network: string,
  account: string,
  signingPubKey: string,
  known?: XrplAccountState | null,
): Promise<void> {
  const signAddr = deriveAddress(signingPubKey);
  const state = known ?? (await fetchAccountState(network, account));
  if (!state || !state.exists) {
    // Unfunded signer accounts can still sign with their master key pair.
    if (signAddr !== account)
      fail("signer_not_authorized", `key for ${account} is not its master key`);
    return;
  }
  if (state.regularKey && state.regularKey === signAddr) return;
  if (signAddr === account && !state.masterDisabled) return;
  fail("signer_not_authorized", `signing key is not authorized for ${account}`);
}

// ── Post-submission confirmation ─────────────────────────────────────────────

import type { FetchTransaction, ReplayStore } from "./index.js";

export interface ConfirmExactParams {
  requirements: PaymentRequirements;
  txHash: string;
  fetchTransaction: FetchTransaction;
  replayStore: ReplayStore;
  /** Idempotency key; defaults to `extra.invoiceId` when present, else `txHash`. */
  paymentId?: string;
}

export interface ConfirmExactResult {
  ok: true;
  idempotent: boolean;
  txHash: string;
  payerAccount?: string;
}

/**
 * Confirm that a submitted `exact` payment validated successfully on-ledger:
 * `tesSUCCESS`, destination and delivered amount match the requirements, and
 * the invoice binding holds. Replay-safe on `paymentId`.
 */
export async function confirmExactSettlement(
  params: ConfirmExactParams,
): Promise<ConfirmExactResult> {
  const { requirements, txHash } = params;
  const network = canonicalNetwork(requirements.network as never);
  const paymentId =
    params.paymentId ??
    (requirements.extra?.invoiceId as string | undefined) ??
    txHash;

  const priorHash = params.replayStore.getTxHashByPaymentId(paymentId);
  if (priorHash !== undefined && priorHash !== txHash)
    fail("replay_detected", "paymentId used with a different txHash");
  const priorId = params.replayStore.getPaymentIdByTxHash(txHash);
  if (priorId !== undefined && priorId !== paymentId)
    fail("replay_detected", "txHash used with a different paymentId");
  if (priorHash === txHash && priorId === paymentId) {
    return { ok: true, idempotent: true, txHash };
  }

  const tx = await params.fetchTransaction(network as never, txHash);
  if (tx === null) fail("invalid_transaction", "transaction not found");
  if (!tx.validated || tx.TransactionType !== "Payment")
    fail("tx_failed", "transaction is not a validated Payment");
  if (tx.meta?.TransactionResult !== "tesSUCCESS") {
    fail(
      "tx_failed",
      `transaction did not succeed: ${tx.meta?.TransactionResult ?? "no metadata"}`,
    );
  }
  if (tx.Destination !== requirements.payTo)
    fail("destination_mismatch", "Destination does not match payTo");

  const invoiceId = requirements.extra?.invoiceId;
  if (typeof invoiceId === "string" && invoiceId.length > 0) {
    const txInvoice = (tx as { InvoiceID?: unknown }).InvoiceID;
    if (
      typeof txInvoice !== "string" ||
      txInvoice.toUpperCase() !== invoiceIdToField(invoiceId)
    ) {
      fail(
        "invoice_mismatch",
        "InvoiceID does not bind to the required invoiceId",
      );
    }
  }

  const delivered = tx.meta?.delivered_amount;
  if (delivered === undefined || delivered === "unavailable")
    fail("tx_failed", "meta.delivered_amount is required");
  const m = amountMatches(requirements, delivered as XrplAmount);
  if (!m.ok) fail(m.reason!, "delivered amount does not match requirements");

  params.replayStore.register(paymentId, txHash);
  return { ok: true, idempotent: false, txHash, payerAccount: tx.Account };
}
