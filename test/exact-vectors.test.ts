import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ExactVerificationError,
  verifyExactPayload,
  type XrplAccountState,
} from "../src/exact.js";
import type { PaymentRequirements } from "../src/index.js";
import {
  VECTORS_PATH,
  renderVectors,
} from "../scripts/gen-exact-multisig-vectors.js";

interface VectorFile {
  version: number;
  requirements: PaymentRequirements;
  validatedLedgerIndex: number;
  cases: Array<{
    id: string;
    description: string;
    signedTxBlob: string;
    accountStates: Record<string, XrplAccountState>;
    expect: { ok: true } | { ok: false; code: string; specIdentifier: string };
  }>;
}

/**
 * The §10.1 identifier for each adapter code, written out from the spec
 * (x402-foundation/x402#4196) rather than derived, so a wrong identifier in the
 * generator fails here. A code missing from this table fails too.
 */
const IDENTIFIER_FOR_CODE: Record<string, string> = {
  invalid_transaction: "invalid_exact_xrpl_payload_multisig_signers_malformed",
  multisig_account_not_found:
    "invalid_exact_xrpl_payload_multisig_account_not_found",
  multisig_signer_not_authorized:
    "invalid_exact_xrpl_payload_multisig_signer_not_authorized",
  multisig_signature_invalid:
    "invalid_exact_xrpl_payload_multisig_signature_invalid",
  multisig_quorum_not_met: "invalid_exact_xrpl_payload_multisig_quorum_not_met",
};

const committed = await readFile(VECTORS_PATH, "utf8");
const vectors = JSON.parse(committed) as VectorFile;

test("exact multisig vectors file is format version 2", () => {
  assert.equal(vectors.version, 2);
});

test("exact multisig vectors are reproducible from their generator", () => {
  // Regenerating must give the committed file exactly: fixed seeds and
  // deterministic ed25519 signatures. Run `pnpm vectors:exact-multisig` after
  // an intentional change.
  assert.equal(renderVectors(), committed);
});

for (const c of vectors.cases) {
  test(`exact multisig vector: ${c.id}`, async () => {
    const run = verifyExactPayload({
      requirements: vectors.requirements,
      payload: { signedTxBlob: c.signedTxBlob },
      fetchAccountState: async (_network, account) =>
        c.accountStates[account] ?? null,
      validatedLedgerIndex: vectors.validatedLedgerIndex,
    });
    if (c.expect.ok) {
      const r = await run;
      assert.equal(r.ok, true);
      assert.equal(r.multisig, true);
      return;
    }
    const { code, specIdentifier } = c.expect;
    assert.ok(code in IDENTIFIER_FOR_CODE, `no §10.1 identifier for ${code}`);
    assert.equal(specIdentifier, IDENTIFIER_FOR_CODE[code]);
    await assert.rejects(run, (e: unknown) => {
      assert(e instanceof ExactVerificationError, String(e));
      assert.equal(e.code, code, `${c.description}: ${e.message}`);
      return true;
    });
  });
}
