export const ADAPTER_VERSION = "0.2.0";
export const RECEIPT_HEADER_NAME = "X-PAYMENT-RECEIPT";

/**
 * CAIP-2 identifiers for XRPL networks, as used by the x402 XRPL ecosystem
 * (xrpl.org, the x402 Foundation reference scheme): the reference is the
 * network ID. `xrpl:0` = Mainnet, `xrpl:1` = Testnet, `xrpl:2` = Devnet.
 * Named aliases are accepted and compare equal to their canonical form.
 *
 * Breaking change in 0.2.0: `xrpl:1` used to mean Mainnet in this package.
 */
export const CANONICAL_NETWORKS = ["xrpl:0", "xrpl:1", "xrpl:2"] as const;
export type CanonicalXrplNetwork = (typeof CANONICAL_NETWORKS)[number];

export const NETWORK_ALIASES = {
  "xrpl:mainnet": "xrpl:0",
  "xrpl:testnet": "xrpl:1",
  "xrpl:devnet": "xrpl:2",
} as const satisfies Record<string, CanonicalXrplNetwork>;

export const SUPPORTED_NETWORKS = [
  ...CANONICAL_NETWORKS,
  ...(Object.keys(NETWORK_ALIASES) as (keyof typeof NETWORK_ALIASES)[]),
] as const;
export type XrplNetwork = CanonicalXrplNetwork | keyof typeof NETWORK_ALIASES;

/** Canonical CAIP-2 form of a supported network identifier. */
export function canonicalNetwork(network: XrplNetwork): CanonicalXrplNetwork {
  assertSupportedNetwork(network);
  return (
    (NETWORK_ALIASES as Record<string, CanonicalXrplNetwork>)[network] ??
    (network as CanonicalXrplNetwork)
  );
}

export type SettlementErrorCode =
  | "expired_challenge"
  | "invalid_challenge"
  | "invalid_receipt"
  | "network_mismatch"
  | "invalid_amount"
  | "invalid_asset"
  | "invalid_destination"
  | "invalid_memo"
  | "replay_detected"
  | "tx_not_validated"
  | "tx_not_found"
  | "tx_failed";

export class SettlementVerificationError extends Error {
  readonly code: SettlementErrorCode;

  constructor(code: SettlementErrorCode, message: string) {
    super(message);
    this.name = "SettlementVerificationError";
    this.code = code;
  }
}

export interface XrpAsset {
  kind: "XRP";
}

export interface IouAsset {
  kind: "IOU";
  currency: string;
  issuer: string;
}

export type ChallengeAsset = XrpAsset | IouAsset;

export interface ChallengeMemo {
  format: "x402";
  paymentId: string;
  sessionId?: string;
}

export interface X402Challenge {
  version: "2";
  network: XrplNetwork;
  amount: string;
  asset: ChallengeAsset;
  destination: string;
  expiresAt: string;
  paymentId: string;
  memo: ChallengeMemo;
}

export interface X402Receipt {
  network: XrplNetwork;
  txHash: string;
  paymentId: string;
}

export interface X402MemoData {
  v: 1;
  t: "x402";
  paymentId: string;
  sessionId?: string;
}

export interface XrplMemoField {
  MemoType?: string;
  MemoFormat?: string;
  MemoData?: string;
}

export interface XrplMemoContainer {
  Memo?: XrplMemoField;
}

export interface XrplIssuedAmount {
  currency: string;
  issuer: string;
  value: string;
}

export interface XrplTransactionMeta {
  /** Engine result. Only `tesSUCCESS` moved funds; `tec*` results are validated but deliver nothing. */
  TransactionResult?: string;
  /** Amount actually delivered (rippled's synthetic `delivered_amount`). */
  delivered_amount?: string | XrplIssuedAmount | "unavailable";
}

export interface XrplPaymentTransaction {
  validated: boolean;
  TransactionType: string;
  Account?: string;
  Destination?: string;
  DestinationTag?: number;
  Amount?: string | XrplIssuedAmount;
  /** API v2 name for `Amount` on Payment transactions. */
  DeliverMax?: string | XrplIssuedAmount;
  Flags?: number;
  Memos?: XrplMemoContainer[];
  SendMax?: unknown;
  Paths?: unknown;
  DeliverMin?: unknown;
  /** Transaction metadata. Required: verification fails closed without it. */
  meta?: XrplTransactionMeta;
  /**
   * ISO-8601 UTC close time of the ledger that validated the transaction. When
   * present, the challenge expiry is checked against it (when the payer paid),
   * not against the verification time.
   */
  closeTime?: string;
}

export type FetchTransactionResult = XrplPaymentTransaction | null;

export type FetchTransaction = (
  network: XrplNetwork,
  txHash: string,
) => Promise<FetchTransactionResult>;

export interface ReplayStore {
  getTxHashByPaymentId(paymentId: string): string | undefined;
  getPaymentIdByTxHash(txHash: string): string | undefined;
  register(paymentId: string, txHash: string): void;
}

export interface VerifySettlementParams {
  challenge: X402Challenge;
  receiptHeaderValue: string;
  fetchTransaction: FetchTransaction;
  replayStore: ReplayStore;
  now?: Date;
  /**
   * How long after `expiresAt` a receipt may still be presented, in seconds,
   * for a payment that was validated before `expiresAt` (ledger validation
   * takes a few seconds). Default 60. Requires `closeTime` from the fetcher;
   * without it the payment time is taken to be the verification time.
   */
  settlementGraceSeconds?: number;
}

export interface VerifySettlementResult {
  ok: true;
  idempotent: boolean;
  receipt: X402Receipt;
  payerAccount?: string;
}

const PARTIAL_PAYMENT_FLAG = 0x00020000;
const RIPPLE_EPOCH_OFFSET_SECONDS = 946684800;

/**
 * Map a rippled / Clio `tx` method result (API v1 or v2) to the shape
 * `verifySettlement` expects, including metadata and the ledger close time.
 * Use it inside your `fetchTransaction` implementation:
 *
 *   const r = await client.request({ command: "tx", transaction: txHash });
 *   return fromRippledTx(r.result);
 */
export function fromRippledTx(result: unknown): XrplPaymentTransaction | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const r = result as Record<string, unknown>;
  // API v2 nests the transaction under tx_json; API v1 inlines it.
  const tx = (
    typeof r.tx_json === "object" && r.tx_json !== null ? r.tx_json : r
  ) as Record<string, unknown>;
  const meta = (
    typeof r.meta === "object" && r.meta !== null ? r.meta : undefined
  ) as XrplTransactionMeta | undefined;

  let closeTime: string | undefined;
  if (typeof r.close_time_iso === "string") {
    closeTime = new Date(r.close_time_iso).toISOString();
  } else {
    const date = typeof tx.date === "number" ? tx.date : r.date;
    if (typeof date === "number") {
      closeTime = new Date(
        (date + RIPPLE_EPOCH_OFFSET_SECONDS) * 1000,
      ).toISOString();
    }
  }

  return {
    validated: r.validated === true,
    TransactionType: String(tx.TransactionType ?? ""),
    Account: tx.Account as string | undefined,
    Destination: tx.Destination as string | undefined,
    DestinationTag: tx.DestinationTag as number | undefined,
    Amount: tx.Amount as XrplPaymentTransaction["Amount"],
    DeliverMax: tx.DeliverMax as XrplPaymentTransaction["DeliverMax"],
    Flags: tx.Flags as number | undefined,
    Memos: tx.Memos as XrplMemoContainer[] | undefined,
    SendMax: tx.SendMax,
    Paths: tx.Paths,
    DeliverMin: tx.DeliverMin,
    meta,
    closeTime,
  };
}

export class InMemoryReplayStore implements ReplayStore {
  private readonly paymentIdToTxHash = new Map<string, string>();
  private readonly txHashToPaymentId = new Map<string, string>();

  getTxHashByPaymentId(paymentId: string): string | undefined {
    return this.paymentIdToTxHash.get(paymentId);
  }

  getPaymentIdByTxHash(txHash: string): string | undefined {
    return this.txHashToPaymentId.get(txHash);
  }

  register(paymentId: string, txHash: string): void {
    const existingTxHash = this.paymentIdToTxHash.get(paymentId);
    if (existingTxHash !== undefined && existingTxHash !== txHash) {
      throw new SettlementVerificationError(
        "replay_detected",
        "replay_detected: paymentId used with different txHash",
      );
    }

    const existingPaymentId = this.txHashToPaymentId.get(txHash);
    if (existingPaymentId !== undefined && existingPaymentId !== paymentId) {
      throw new SettlementVerificationError(
        "replay_detected",
        "replay_detected: txHash used with different paymentId",
      );
    }

    this.paymentIdToTxHash.set(paymentId, txHash);
    this.txHashToPaymentId.set(txHash, paymentId);
  }
}

export function createChallenge(params: {
  network: XrplNetwork;
  amount: string;
  asset: ChallengeAsset;
  destination: string;
  expiresAt: string;
  paymentId: string;
  sessionId?: string;
}): X402Challenge {
  assertSupportedNetwork(params.network);
  assertDecimalAmount(params.amount, "invalid_challenge");
  assertFutureOrPresentISODate(params.expiresAt, "invalid_challenge");

  if (params.asset.kind === "IOU") {
    assertNonEmpty(
      params.asset.currency,
      "asset.currency",
      "invalid_challenge",
    );
    assertNonEmpty(params.asset.issuer, "asset.issuer", "invalid_challenge");
  }

  assertNonEmpty(params.destination, "destination", "invalid_challenge");
  assertNonEmpty(params.paymentId, "paymentId", "invalid_challenge");

  return {
    version: "2",
    network: params.network,
    amount: normalizeDecimal(params.amount),
    asset: params.asset,
    destination: params.destination,
    expiresAt: params.expiresAt,
    paymentId: params.paymentId,
    memo: {
      format: "x402",
      paymentId: params.paymentId,
      sessionId: params.sessionId,
    },
  };
}

export function encodeReceiptHeader(receipt: X402Receipt): string {
  assertSupportedNetwork(receipt.network);
  assertNonEmpty(receipt.txHash, "txHash", "invalid_receipt");
  assertNonEmpty(receipt.paymentId, "paymentId", "invalid_receipt");
  return utf8ToBase64(JSON.stringify(receipt));
}

export function decodeReceiptHeader(receiptHeaderValue: string): X402Receipt {
  let decoded: unknown;
  try {
    decoded = JSON.parse(base64ToUtf8(receiptHeaderValue));
  } catch {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt header is not valid base64 JSON",
    );
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt payload must be an object",
    );
  }

  const maybe = decoded as Partial<X402Receipt>;
  if (typeof maybe.network !== "string") {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt.network is required",
    );
  }
  if (!isSupportedNetwork(maybe.network)) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt.network is not supported",
    );
  }
  if (typeof maybe.txHash !== "string" || maybe.txHash.length === 0) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt.txHash is required",
    );
  }
  if (typeof maybe.paymentId !== "string" || maybe.paymentId.length === 0) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt.paymentId is required",
    );
  }

  return {
    network: maybe.network,
    txHash: maybe.txHash,
    paymentId: maybe.paymentId,
  };
}

export function buildXrplMemo(
  challenge: Pick<X402Challenge, "paymentId" | "memo">,
): XrplMemoContainer {
  const memoData: X402MemoData = {
    v: 1,
    t: "x402",
    paymentId: challenge.paymentId,
    sessionId: challenge.memo.sessionId,
  };

  return {
    Memo: {
      MemoType: utf8ToHex("x402"),
      MemoFormat: utf8ToHex("application/json"),
      MemoData: utf8ToHex(JSON.stringify(memoData)),
    },
  };
}

export async function verifySettlement(
  params: VerifySettlementParams,
): Promise<VerifySettlementResult> {
  const now = params.now ?? new Date();

  validateChallenge(params.challenge);
  const graceMs = (params.settlementGraceSeconds ?? 60) * 1000;
  if (!(graceMs >= 0)) {
    throw new SettlementVerificationError(
      "invalid_challenge",
      "settlementGraceSeconds must be a non-negative number",
    );
  }
  // Receipts presented long after expiry are refused outright (this also bounds
  // the window in which a non-persistent replay store could be bypassed).
  validateChallengeNotExpired(
    params.challenge,
    now,
    graceMs,
    "challenge has expired",
  );

  const receipt = decodeReceiptHeader(params.receiptHeaderValue);
  const network = canonicalNetwork(params.challenge.network);

  if (canonicalNetwork(receipt.network) !== network) {
    throw new SettlementVerificationError(
      "network_mismatch",
      "receipt.network does not match challenge.network",
    );
  }
  if (receipt.paymentId !== params.challenge.paymentId) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "receipt.paymentId does not match challenge.paymentId",
    );
  }

  const existingTxHash = params.replayStore.getTxHashByPaymentId(
    params.challenge.paymentId,
  );
  if (existingTxHash !== undefined && existingTxHash !== receipt.txHash) {
    throw new SettlementVerificationError(
      "replay_detected",
      "replay_detected: paymentId used with different txHash",
    );
  }

  const existingPaymentId = params.replayStore.getPaymentIdByTxHash(
    receipt.txHash,
  );
  if (
    existingPaymentId !== undefined &&
    existingPaymentId !== params.challenge.paymentId
  ) {
    throw new SettlementVerificationError(
      "replay_detected",
      "replay_detected: txHash used with different paymentId",
    );
  }

  if (
    existingTxHash === receipt.txHash &&
    existingPaymentId === params.challenge.paymentId
  ) {
    return { ok: true, idempotent: true, receipt };
  }

  const tx = await params.fetchTransaction(network, receipt.txHash);
  if (tx === null) {
    throw new SettlementVerificationError(
      "tx_not_found",
      "transaction not found",
    );
  }

  if (!tx.validated || tx.TransactionType !== "Payment") {
    throw new SettlementVerificationError(
      "tx_not_validated",
      "transaction is not a validated Payment",
    );
  }
  // A validated transaction is not necessarily a successful one: tec* results
  // are included in a ledger (the fee is charged) but deliver nothing.
  const result = tx.meta?.TransactionResult;
  if (result !== "tesSUCCESS") {
    throw new SettlementVerificationError(
      "tx_failed",
      result === undefined
        ? "transaction metadata (meta.TransactionResult) is required"
        : `transaction did not succeed: ${result}`,
    );
  }
  if (typeof tx.Account !== "string" || tx.Account.trim().length === 0) {
    throw new SettlementVerificationError(
      "invalid_receipt",
      "tx.Account (payer address) is required",
    );
  }

  if (tx.Destination !== params.challenge.destination) {
    throw new SettlementVerificationError(
      "invalid_destination",
      "transaction destination does not match challenge",
    );
  }
  if (tx.DestinationTag !== undefined) {
    throw new SettlementVerificationError(
      "invalid_destination",
      "DestinationTag is not supported in v1 safe mode",
    );
  }

  if ((tx.Flags ?? 0) & PARTIAL_PAYMENT_FLAG) {
    throw new SettlementVerificationError(
      "invalid_asset",
      "partial payment flag is not allowed in v1",
    );
  }
  if (
    tx.Paths !== undefined ||
    tx.SendMax !== undefined ||
    tx.DeliverMin !== undefined
  ) {
    throw new SettlementVerificationError(
      "invalid_asset",
      "path payment fields (Paths/SendMax/DeliverMin) are not allowed in v1",
    );
  }

  assertAmountAndAssetMatch(params.challenge, tx.Amount ?? tx.DeliverMax);

  // The delivered amount is authoritative (it is what the destination received).
  const delivered = tx.meta?.delivered_amount;
  if (delivered === undefined || delivered === "unavailable") {
    throw new SettlementVerificationError(
      "tx_failed",
      "meta.delivered_amount is required",
    );
  }
  assertAmountAndAssetMatch(params.challenge, delivered);

  assertMemoMatches(tx.Memos, params.challenge);

  // Expiry: was the payment made in time? Use the validating ledger's close
  // time when the fetcher provides it; otherwise the verification time.
  if (tx.closeTime !== undefined) {
    validateChallengeNotExpired(
      params.challenge,
      parseLedgerTime(tx.closeTime),
      0,
      "payment was validated after the challenge expired",
    );
  } else {
    validateChallengeNotExpired(
      params.challenge,
      now,
      0,
      "challenge has expired",
    );
  }

  params.replayStore.register(params.challenge.paymentId, receipt.txHash);

  return {
    ok: true,
    idempotent: false,
    receipt,
    payerAccount: tx.Account,
  };
}

function validateChallenge(challenge: X402Challenge): void {
  assertSupportedNetwork(challenge.network);

  if (challenge.version !== "2") {
    throw new SettlementVerificationError(
      "invalid_challenge",
      "challenge.version must be 2",
    );
  }
  assertDecimalAmount(challenge.amount, "invalid_challenge");
  assertNonEmpty(
    challenge.destination,
    "challenge.destination",
    "invalid_challenge",
  );
  assertNonEmpty(
    challenge.paymentId,
    "challenge.paymentId",
    "invalid_challenge",
  );

  if (challenge.asset.kind === "IOU") {
    assertNonEmpty(
      challenge.asset.currency,
      "challenge.asset.currency",
      "invalid_challenge",
    );
    assertNonEmpty(
      challenge.asset.issuer,
      "challenge.asset.issuer",
      "invalid_challenge",
    );
  }

  if (challenge.memo.format !== "x402") {
    throw new SettlementVerificationError(
      "invalid_challenge",
      "challenge.memo.format must be x402",
    );
  }
  if (challenge.memo.paymentId !== challenge.paymentId) {
    throw new SettlementVerificationError(
      "invalid_challenge",
      "challenge.memo.paymentId must match challenge.paymentId",
    );
  }
  assertFutureOrPresentISODate(challenge.expiresAt, "invalid_challenge");
}

function parseLedgerTime(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SettlementVerificationError(
      "tx_not_validated",
      "tx.closeTime is not a valid ISO-8601 timestamp",
    );
  }
  return date;
}

function validateChallengeNotExpired(
  challenge: X402Challenge,
  at: Date,
  graceMs: number,
  message: string,
): void {
  const expiresAt = new Date(challenge.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new SettlementVerificationError(
      "invalid_challenge",
      "challenge.expiresAt is not valid ISO-8601",
    );
  }
  if (at.getTime() > expiresAt.getTime() + graceMs) {
    throw new SettlementVerificationError("expired_challenge", message);
  }
}

function assertAmountAndAssetMatch(
  challenge: Pick<X402Challenge, "asset" | "amount">,
  txAmount: XrplPaymentTransaction["Amount"],
): void {
  // Challenge amounts are stored as normalized decimal strings.
  const expected = challenge.amount;

  if (challenge.asset.kind === "XRP") {
    if (typeof txAmount !== "string") {
      throw new SettlementVerificationError(
        "invalid_asset",
        "expected XRP amount in drops string form",
      );
    }

    const expectedDrops = xrpToDrops(expected);
    if (txAmount !== expectedDrops) {
      throw new SettlementVerificationError(
        "invalid_amount",
        "XRP amount (drops) does not match challenge amount",
      );
    }

    return;
  }

  if (
    txAmount === undefined ||
    typeof txAmount !== "object" ||
    typeof txAmount.currency !== "string" ||
    typeof txAmount.issuer !== "string" ||
    typeof txAmount.value !== "string"
  ) {
    throw new SettlementVerificationError(
      "invalid_asset",
      "expected IOU issued amount",
    );
  }

  if (
    txAmount.currency !== challenge.asset.currency ||
    txAmount.issuer !== challenge.asset.issuer
  ) {
    throw new SettlementVerificationError(
      "invalid_asset",
      "IOU currency/issuer does not match challenge",
    );
  }

  // v1 strict mode: exact string equality (no normalization beyond challenge normalization).
  if (txAmount.value !== expected) {
    throw new SettlementVerificationError(
      "invalid_amount",
      "IOU amount does not match challenge amount",
    );
  }
}

function assertMemoMatches(
  memos: XrplMemoContainer[] | undefined,
  challenge: Pick<X402Challenge, "paymentId" | "memo">,
): void {
  if (memos === undefined || memos.length === 0) {
    throw new SettlementVerificationError(
      "invalid_memo",
      "transaction memo is required",
    );
  }

  for (const memoContainer of memos) {
    const memo = memoContainer.Memo;
    if (memo === undefined) {
      continue;
    }

    const memoType = decodeMemoField(memo.MemoType);
    const memoFormat = decodeMemoField(memo.MemoFormat);
    const memoDataHex = memo.MemoData;
    if (memoDataHex === undefined || memoDataHex.length === 0) {
      continue;
    }

    let memoData: string;
    try {
      memoData = hexToUtf8(memoDataHex);
    } catch {
      throw new SettlementVerificationError(
        "invalid_memo",
        "MemoData must be hex-encoded UTF-8 JSON",
      );
    }

    if (
      memoType !== "x402" ||
      memoFormat !== "application/json" ||
      memoData === ""
    ) {
      continue;
    }

    try {
      const parsed = JSON.parse(memoData) as Partial<X402MemoData>;
      if (
        parsed.v === 1 &&
        parsed.t === "x402" &&
        typeof parsed.paymentId === "string" &&
        parsed.paymentId === challenge.paymentId
      ) {
        // If challenge includes a sessionId, the memo MUST carry the same value.
        if (
          challenge.memo.sessionId !== undefined &&
          parsed.sessionId !== challenge.memo.sessionId
        ) {
          throw new SettlementVerificationError(
            "invalid_memo",
            "memo sessionId does not match challenge sessionId",
          );
        }
        return;
      }
    } catch (err) {
      if (err instanceof SettlementVerificationError) {
        throw err;
      }
      throw new SettlementVerificationError(
        "invalid_memo",
        "memo JSON is malformed",
      );
    }
  }

  throw new SettlementVerificationError(
    "invalid_memo",
    "no valid x402 memo found with matching paymentId",
  );
}

function isSupportedNetwork(value: string): value is XrplNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

function assertSupportedNetwork(
  network: string,
): asserts network is XrplNetwork {
  if (!isSupportedNetwork(network)) {
    throw new SettlementVerificationError(
      "network_mismatch",
      `unsupported network: ${network}`,
    );
  }
}

function assertFutureOrPresentISODate(
  value: string,
  errorCode: SettlementErrorCode = "invalid_challenge",
): void {
  const date = new Date(value);
  if (
    Number.isNaN(date.getTime()) ||
    !value.includes("T") ||
    !value.endsWith("Z")
  ) {
    throw new SettlementVerificationError(
      errorCode,
      "expiresAt must be an ISO-8601 UTC timestamp",
    );
  }
}

function assertDecimalAmount(
  value: string,
  errorCode: SettlementErrorCode = "invalid_amount",
): void {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new SettlementVerificationError(
      errorCode,
      `invalid decimal amount: ${value}`,
    );
  }
}

function assertNonEmpty(
  value: string,
  field: string,
  errorCode: SettlementErrorCode = "invalid_challenge",
): void {
  if (value.trim().length === 0) {
    throw new SettlementVerificationError(errorCode, `${field} is required`);
  }
}

function normalizeDecimal(value: string): string {
  assertDecimalAmount(value);
  const [rawInteger, rawFraction] = value.split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/, "") || "0";
  const fraction = rawFraction?.replace(/0+$/, "") ?? "";
  return fraction.length > 0 ? `${integer}.${fraction}` : integer;
}

function xrpToDrops(xrp: string): string {
  // xrp is a normalized decimal string from normalizeDecimal / createChallenge
  assertDecimalAmount(xrp, "invalid_amount");

  const [rawInteger, rawFraction = ""] = xrp.split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/, "") || "0";

  if (rawFraction.length > 6) {
    throw new SettlementVerificationError(
      "invalid_amount",
      "XRP amount must have at most 6 decimal places",
    );
  }

  const fractionPadded = rawFraction.padEnd(6, "0");
  const drops = (integer + fractionPadded).replace(/^0+(?=\d)/, "") || "0";
  return drops;
}

function dropsToXrp(drops: string): string {
  if (!/^\d+$/.test(drops)) {
    throw new SettlementVerificationError(
      "invalid_amount",
      "XRP drops amount must be an unsigned integer string",
    );
  }

  const padded = drops.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "") || "0";
  const fractional = padded.slice(-6).replace(/0+$/, "");
  return fractional.length > 0 ? `${whole}.${fractional}` : whole;
}

function decodeMemoField(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    return "";
  }

  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    try {
      return hexToUtf8(value);
    } catch {
      throw new SettlementVerificationError(
        "invalid_memo",
        "memo field contains invalid hex",
      );
    }
  }

  return value;
}

function utf8ToHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToUtf8(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const parsed = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(parsed)) {
      throw new Error("Invalid hex");
    }
    bytes[i / 2] = parsed;
  }
  return new TextDecoder().decode(bytes);
}

function utf8ToBase64(input: string): string {
  return Buffer.from(input, "utf8").toString("base64");
}

function base64ToUtf8(input: string): string {
  return Buffer.from(input, "base64").toString("utf8");
}
