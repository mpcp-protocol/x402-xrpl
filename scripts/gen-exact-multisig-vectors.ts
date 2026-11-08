/**
 * Generates conformance/exact_multisig_vectors.json: deterministic vectors for
 * multisig verification in the `exact` scheme (x402 XRPL exact spec §10.1).
 *
 * Every wallet comes from a fixed seed and ed25519 signatures are
 * deterministic, so running this again produces byte-identical output.
 * test/exact-vectors.test.ts checks that.
 *
 *   pnpm vectors:exact-multisig
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode } from "ripple-binary-codec";
import { generateSeed } from "ripple-keypairs";

import type { XrplAccountState } from "../src/exact.js";
import {
  byAccountId,
  multiSigned as multiSign,
  wallet,
  type SignerSpec,
  type Tx,
  type Wallet,
} from "../test/support/multisig.js";

export const VECTORS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "conformance",
  "exact_multisig_vectors.json",
);

/** Test-only wallet whose seed entropy is sha256(label), truncated to 16 bytes. */
function fixedWallet(label: string): Wallet {
  const entropy = createHash("sha256")
    .update(`x402-xrpl exact multisig vector: ${label}`)
    .digest()
    .subarray(0, 16);
  return wallet(
    generateSeed({ entropy: new Uint8Array(entropy), algorithm: "ed25519" }),
  );
}

const LEDGER = 1000;
const payer = fixedWallet("payer");
const merchant = fixedWallet("merchant");
const s1 = fixedWallet("signer-1");
const s2 = fixedWallet("signer-2");
const s3 = fixedWallet("signer-3");
const outsider = fixedWallet("outsider");
const regularKeyHolder = fixedWallet("signer-2-regular-key");
// A pair whose address-string order and account-ID order disagree:
// as strings rMwCk… < rpvva…, but by account ID rpvva… comes first.
const strM = wallet("sEdSJHS4oiAdz7w2X2ni1gFiihccMfL"); // rMwCk9x2…
const strP = wallet("sEdSJHS4oiAdz7w2X2ni1gFiiN7Jpvj"); // rpvvavrQ…

const requirements = {
  scheme: "exact",
  network: "xrpl:1",
  amount: "1000000",
  asset: "XRP",
  payTo: merchant.address,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: false },
};

function baseTx(over: Tx = {}): Tx {
  return {
    TransactionType: "Payment",
    Account: payer.address,
    Destination: merchant.address,
    Amount: "1000000",
    Fee: "30",
    Sequence: 7,
    LastLedgerSequence: LEDGER + 10,
    ...over,
  };
}

/** Multisigns the base transaction (see test/support/multisig.ts). */
function multiSigned(
  signers: SignerSpec[],
  opts: { keepOrder?: boolean } = {},
): string {
  return multiSign(baseTx(), signers, opts);
}

type AccountState = XrplAccountState;
const funded = (over: Partial<AccountState> = {}): AccountState => ({
  exists: true,
  masterDisabled: false,
  regularKey: null,
  sequence: 1,
  ...over,
});
/** Payer: master key disabled, 2-of-3 SignerList (weights 1, 1, 1). */
function payerState(
  signerList: AccountState["signerList"] = {
    quorum: 2,
    signers: [
      { account: s1.address, weight: 1 },
      { account: s2.address, weight: 1 },
      { account: s3.address, weight: 1 },
    ],
  },
): AccountState {
  return funded({ sequence: 7, masterDisabled: true, signerList });
}
function states(
  extra: Record<string, AccountState> = {},
): Record<string, AccountState> {
  return {
    [payer.address]: payerState(),
    [s1.address]: funded(),
    [s2.address]: funded(),
    [s3.address]: funded(),
    ...extra,
  };
}

/** Proposed spec identifiers (x402 XRPL exact spec §10.1) for each adapter code. */
const SPEC_IDENTIFIER: Record<string, string> = {
  multisig_account_not_found:
    "invalid_exact_xrpl_payload_multisig_account_not_found",
  multisig_signer_not_authorized:
    "invalid_exact_xrpl_payload_multisig_signer_not_authorized",
  multisig_signature_invalid:
    "invalid_exact_xrpl_payload_multisig_signature_invalid",
  multisig_quorum_not_met: "invalid_exact_xrpl_payload_multisig_quorum_not_met",
};

interface Case {
  id: string;
  description: string;
  specRule: string;
  signedTxBlob: string;
  accountStates: Record<string, AccountState>;
  expect: { ok: true } | { ok: false; code: string; specIdentifier?: string };
}

function ok(
  id: string,
  description: string,
  specRule: string,
  signedTxBlob: string,
  accountStates = states(),
): Case {
  return {
    id,
    description,
    specRule,
    signedTxBlob,
    accountStates,
    expect: { ok: true },
  };
}
function rejects(
  id: string,
  description: string,
  specRule: string,
  code: string,
  signedTxBlob: string,
  accountStates = states(),
): Case {
  const specIdentifier = SPEC_IDENTIFIER[code];
  return {
    id,
    description,
    specRule,
    signedTxBlob,
    accountStates,
    expect: specIdentifier
      ? { ok: false, code, specIdentifier }
      : { ok: false, code },
  };
}

export function buildVectors() {
  const tampered = encode({
    ...(decode(multiSigned([s1, s2])) as Record<string, unknown>),
    Fee: "31",
  } as never);
  const thirtyThree = Array.from({ length: 33 }, (_, i) =>
    fixedWallet(`many-${i}`),
  );
  const unfunded = states();
  delete unfunded[s2.address];
  const strPairStates = states({
    [payer.address]: payerState({
      quorum: 2,
      signers: [
        { account: strM.address, weight: 1 },
        { account: strP.address, weight: 1 },
      ],
    }),
    [strM.address]: funded(),
    [strP.address]: funded(),
  });
  const withPayerOnList = states({
    [payer.address]: payerState({
      quorum: 2,
      signers: [
        { account: payer.address, weight: 1 },
        { account: s1.address, weight: 1 },
        { account: s2.address, weight: 1 },
      ],
    }),
  });

  const cases: Case[] = [
    ok(
      "multisig_at_quorum",
      "2-of-3 SignerList, two listed signers with valid signatures: verifies",
      "§10.1.3, §10.1.4",
      multiSigned([s1, s2]),
    ),
    ok(
      "multisig_all_signers",
      "All three listed signers sign (weight 3 >= quorum 2): verifies",
      "§10.1.4",
      multiSigned([s1, s2, s3]),
    ),
    ok(
      "multisig_unfunded_signer_master_key",
      "A signer account that does not exist on the ledger signs with the key its address derives from: verifies",
      "§10.1.3 (signer account need not exist)",
      multiSigned([s1, s2]),
      unfunded,
    ),
    ok(
      "multisig_signer_regular_key",
      "A signer with its master key disabled signs with its RegularKey: verifies",
      "§10.1.3 (RegularKey authorizes)",
      multiSigned([s1, { as: s2.address, key: regularKeyHolder }]),
      states({
        [s2.address]: funded({
          masterDisabled: true,
          regularKey: regularKeyHolder.address,
        }),
      }),
    ),
    ok(
      "multisig_sorted_by_account_id",
      "Signers in account-ID order, which is the reverse of their address-string order: verifies",
      "§10.1.3 (sort key is AccountID)",
      multiSigned([strP, strM], { keepOrder: true }),
      strPairStates,
    ),
    rejects(
      "multisig_below_quorum",
      "One valid listed signer (weight 1) against quorum 2",
      "§10.1.4",
      "multisig_quorum_not_met",
      multiSigned([s1]),
    ),
    rejects(
      "multisig_signer_not_on_signer_list",
      "One signer is not on the payer's SignerList",
      "§10.1.3",
      "multisig_signer_not_authorized",
      multiSigned([s1, outsider]),
      states({ [outsider.address]: funded() }),
    ),
    rejects(
      "multisig_tampered_after_signing",
      "Fee changed after the signers signed: signatures no longer verify",
      "§10.1.3",
      "multisig_signature_invalid",
      tampered,
    ),
    rejects(
      "multisig_duplicate_signer",
      "The same signer appears twice",
      "§10.1.3",
      "multisig_signer_not_authorized",
      multiSigned([s1, s1]),
    ),
    rejects(
      "multisig_signer_master_disabled",
      "A listed signer signs with its master key, which is disabled, and has no RegularKey",
      "§10.1.3",
      "multisig_signer_not_authorized",
      multiSigned([s1, s2]),
      states({ [s2.address]: funded({ masterDisabled: true }) }),
    ),
    rejects(
      "multisig_unfunded_signer_wrong_key",
      "A signer account that does not exist on the ledger signs with a key that is not its own master key",
      "§10.1.3 (signer account need not exist)",
      "multisig_signer_not_authorized",
      multiSigned([s1, { as: s2.address, key: outsider }]),
      unfunded,
    ),
    rejects(
      "multisig_malformed_signer_entry",
      "A Signer entry has no TxnSignature",
      "§10.1.3",
      "multisig_signature_invalid",
      (() => {
        const tx = decode(multiSigned([s1, s2])) as {
          Signers: { Signer: Record<string, unknown> }[];
        };
        delete tx.Signers[1].Signer.TxnSignature;
        return encode(tx as never);
      })(),
    ),
    rejects(
      "multisig_payer_not_found",
      "The payer account does not exist at the validated ledger",
      "§10.1.2",
      "multisig_account_not_found",
      multiSigned([s1, s2]),
      (() => {
        const m = states();
        delete m[payer.address];
        return m;
      })(),
    ),
    rejects(
      "multisig_payer_no_signer_list",
      "The payer exists but has no SignerList",
      "§10.1.2",
      "multisig_signer_not_authorized",
      multiSigned([s1, s2]),
      states({ [payer.address]: payerState(null) }),
    ),
    rejects(
      "multisig_unsorted_signers",
      "Signers not in ascending account-ID order",
      "§10.1.3",
      "invalid_transaction",
      multiSigned([...[s1, s2].sort(byAccountId)].reverse(), {
        keepOrder: true,
      }),
    ),
    rejects(
      "multisig_sorted_by_address_string",
      "Signers in address-string order, which is not account-ID order for this pair",
      "§10.1.3 (sort key is AccountID)",
      "invalid_transaction",
      multiSigned([strM, strP], { keepOrder: true }),
      strPairStates,
    ),
    rejects(
      "multisig_too_many_signers",
      "33 Signers entries (the maximum is 32)",
      "§10.1.3",
      "invalid_transaction",
      multiSigned(thirtyThree),
    ),
    rejects(
      "multisig_payer_signs_for_itself",
      "The payer account appears among its own signers (even though the fixture lists it on its own SignerList)",
      "§10.1.3",
      "invalid_transaction",
      multiSigned([payer, s1]),
      withPayerOnList,
    ),
    rejects(
      "multisig_nonempty_signing_pub_key",
      "Signers present but the top-level SigningPubKey is not empty",
      "§10.1.1",
      "invalid_transaction",
      encode({
        ...(decode(multiSigned([s1, s2])) as Record<string, unknown>),
        SigningPubKey: s1.publicKey,
      } as never),
    ),
  ];

  return {
    version: 1,
    description:
      "Deterministic conformance vectors for multisig verification in the x402 XRPL `exact` scheme (spec §10.1). Each case is verified offline against `accountStates`, keyed by account address. Keys come from fixed test-only seeds; never use them for real funds.",
    requirements,
    validatedLedgerIndex: LEDGER,
    cases,
  };
}

/** The exact text written to VECTORS_PATH. */
export function renderVectors(): string {
  return JSON.stringify(buildVectors(), null, 2) + "\n";
}

// Resolve symlinks on both sides (e.g. /tmp -> /private/tmp on macOS), or a
// direct run through a symlinked path would silently write nothing.
const isMain =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  await writeFile(VECTORS_PATH, renderVectors());
  console.log(`wrote ${path.relative(process.cwd(), VECTORS_PATH)}`);
}
