/**
 * x402 v2 HTTP wire envelope (protocol-level, scheme-agnostic).
 *
 * Carries the three headers from the x402 v2 specification:
 *   - `PAYMENT-REQUIRED`  (response)  base64(JSON) of a {@link PaymentRequired}
 *   - `PAYMENT-SIGNATURE` (request)   base64(JSON) of a {@link PaymentPayload}
 *   - `PAYMENT-RESPONSE`  (response)  base64(JSON) of a {@link SettlementResponse}
 *
 * This module is dependency-free: it does not decode or verify XRPL
 * transactions. Scheme-specific payload handling lives in the scheme modules
 * (e.g. `./exact`), and on-ledger settlement checks in `./index`.
 */

/** x402 v2 header names. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * Scheme identifiers this package implements.
 *
 * - `exact` — the standard x402 XRPL exact scheme: the client sends a presigned
 *   `Payment` blob, the facilitator verifies it (including signatures) and
 *   submits it. Interoperable with other x402 XRPL `exact` clients. See `./exact`.
 * - `prepaid` — a client-prepaid scheme (x402 v2 §7.2): the client submits the
 *   `Payment` itself and returns the transaction hash; the server verifies the
 *   validated transaction. Binds via an XRPL Memo. This is the flow `./index`
 *   implements; `prepaid` is this package's own scheme name for it.
 */
export const SCHEME_EXACT = "exact";
export const SCHEME_PREPAID = "prepaid";

export class EnvelopeError extends Error {
  readonly code = "invalid_envelope";
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** A single payment option offered by the server (x402 v2 PaymentRequirements). */
export interface PaymentRequirements {
  /** Scheme identifier, e.g. `"exact"` or `"prepaid"`. */
  scheme: string;
  /** CAIP-2 network id (`xrpl:0` mainnet, `xrpl:1` testnet, `xrpl:2` devnet). */
  network: string;
  /**
   * Amount in the asset's atomic units: drops for XRP (e.g. `"2500000"`), or
   * the issued-currency decimal value for an IOU (e.g. `"10.25"`).
   */
  amount: string;
  /** `"XRP"` or the IOU currency code. */
  asset: string;
  /** Destination (payee) classic address. */
  payTo: string;
  /** How long the client has to pay, in seconds. */
  maxTimeoutSeconds: number;
  /** Scheme-specific fields (e.g. `invoiceId`, `issuer`, `destinationTag`, `areFeesSponsored`). */
  extra?: Record<string, unknown>;
}

/** The 402 challenge body (x402 v2 PaymentRequired). */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: string;
  accepts: PaymentRequirements[];
  extensions?: Record<string, unknown>;
}

/** The client's payment submission (x402 v2 PaymentPayload). */
export interface PaymentPayload {
  x402Version: 2;
  resource?: string;
  /** The PaymentRequirements option the client chose to satisfy. */
  accepted: PaymentRequirements;
  /** Scheme-specific payload (e.g. `{ signedTxBlob }` for `exact`). */
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

/** The server's settlement result (x402 v2 SettlementResponse). */
export interface SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** XRPL transaction hash (empty string when unsettled). */
  transaction: string;
  /** CAIP-2 network id. */
  network: string;
  /** Delivered amount in atomic units, when known. */
  amount?: string;
  extensions?: Record<string, unknown>;
}

function toBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function fromBase64Json(headerValue: string, label: string): unknown {
  let text: string;
  try {
    text = Buffer.from(headerValue, "base64").toString("utf8");
  } catch {
    throw new EnvelopeError(`${label} is not valid base64`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EnvelopeError(`${label} is not valid base64 JSON`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EnvelopeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertRequirements(
  value: unknown,
  label: string,
): PaymentRequirements {
  const o = asObject(value, label);
  for (const field of [
    "scheme",
    "network",
    "amount",
    "asset",
    "payTo",
  ] as const) {
    if (typeof o[field] !== "string" || (o[field] as string).length === 0) {
      throw new EnvelopeError(`${label}.${field} is required`);
    }
  }
  if (
    typeof o.maxTimeoutSeconds !== "number" ||
    !Number.isFinite(o.maxTimeoutSeconds)
  ) {
    throw new EnvelopeError(`${label}.maxTimeoutSeconds must be a number`);
  }
  if (o.extra !== undefined) asObject(o.extra, `${label}.extra`);
  return o as unknown as PaymentRequirements;
}

// ── PAYMENT-REQUIRED ─────────────────────────────────────────────────────────

export function encodePaymentRequiredHeader(required: PaymentRequired): string {
  if (required.x402Version !== 2) {
    throw new EnvelopeError("x402Version must be 2");
  }
  if (!Array.isArray(required.accepts) || required.accepts.length === 0) {
    throw new EnvelopeError("accepts must be a non-empty array");
  }
  required.accepts.forEach((r, i) => assertRequirements(r, `accepts[${i}]`));
  return toBase64Json(required);
}

export function decodePaymentRequiredHeader(
  headerValue: string,
): PaymentRequired {
  const o = asObject(
    fromBase64Json(headerValue, "PAYMENT-REQUIRED"),
    "PAYMENT-REQUIRED",
  );
  if (o.x402Version !== 2) {
    throw new EnvelopeError("PAYMENT-REQUIRED x402Version must be 2");
  }
  if (typeof o.resource !== "string") {
    throw new EnvelopeError("PAYMENT-REQUIRED.resource is required");
  }
  if (!Array.isArray(o.accepts) || o.accepts.length === 0) {
    throw new EnvelopeError(
      "PAYMENT-REQUIRED.accepts must be a non-empty array",
    );
  }
  const accepts = o.accepts.map((r, i) =>
    assertRequirements(r, `accepts[${i}]`),
  );
  return { ...(o as object), accepts } as PaymentRequired;
}

// ── PAYMENT-SIGNATURE ────────────────────────────────────────────────────────

export function encodePaymentSignatureHeader(payload: PaymentPayload): string {
  if (payload.x402Version !== 2) {
    throw new EnvelopeError("x402Version must be 2");
  }
  assertRequirements(payload.accepted, "accepted");
  asObject(payload.payload, "payload");
  return toBase64Json(payload);
}

export function decodePaymentSignatureHeader(
  headerValue: string,
): PaymentPayload {
  const o = asObject(
    fromBase64Json(headerValue, "PAYMENT-SIGNATURE"),
    "PAYMENT-SIGNATURE",
  );
  if (o.x402Version !== 2) {
    throw new EnvelopeError("PAYMENT-SIGNATURE x402Version must be 2");
  }
  const accepted = assertRequirements(o.accepted, "accepted");
  const payload = asObject(o.payload, "payload");
  return { ...(o as object), accepted, payload } as PaymentPayload;
}

// ── PAYMENT-RESPONSE ─────────────────────────────────────────────────────────

export function encodePaymentResponseHeader(
  response: SettlementResponse,
): string {
  if (typeof response.success !== "boolean") {
    throw new EnvelopeError("success must be a boolean");
  }
  if (
    typeof response.transaction !== "string" ||
    typeof response.network !== "string"
  ) {
    throw new EnvelopeError("transaction and network are required");
  }
  return toBase64Json(response);
}

export function decodePaymentResponseHeader(
  headerValue: string,
): SettlementResponse {
  const o = asObject(
    fromBase64Json(headerValue, "PAYMENT-RESPONSE"),
    "PAYMENT-RESPONSE",
  );
  if (typeof o.success !== "boolean") {
    throw new EnvelopeError("PAYMENT-RESPONSE.success must be a boolean");
  }
  if (typeof o.transaction !== "string" || typeof o.network !== "string") {
    throw new EnvelopeError(
      "PAYMENT-RESPONSE.transaction and network are required",
    );
  }
  return o as unknown as SettlementResponse;
}
