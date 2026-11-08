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

const committed = await readFile(VECTORS_PATH, "utf8");
const vectors = JSON.parse(committed) as VectorFile;

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
    // Every rejection names its §10.1 identifier: "invalid_exact_xrpl_payload_"
    // + code for multisig_* codes, and ..._multisig_signers_malformed for the
    // structural failures the adapter reports as invalid_transaction.
    assert.equal(
      specIdentifier,
      code === "invalid_transaction"
        ? "invalid_exact_xrpl_payload_multisig_signers_malformed"
        : `invalid_exact_xrpl_payload_${code}`,
    );
    assert.ok(
      code === "invalid_transaction" || code.startsWith("multisig_"),
      `unexpected code ${code}`,
    );
    await assert.rejects(run, (e: unknown) => {
      assert(e instanceof ExactVerificationError, String(e));
      assert.equal(e.code, code, `${c.description}: ${e.message}`);
      return true;
    });
  });
}
