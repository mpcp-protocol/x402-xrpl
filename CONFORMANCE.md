# Conformance

This package targets the XRPL adapter specification in `docs/SPEC.md`.

## Current status

- Core settlement verification invariants are covered in tests under `test/`.
- `exact` multisig verification is covered by deterministic conformance vectors (below).
- Replay/idempotency behavior is validated with mocked transaction fetches.
- Error code semantics include challenge, receipt, memo, and replay classes.

## `exact` multisig vectors

[`conformance/exact_multisig_vectors.json`](https://github.com/mpcp-protocol/x402-xrpl/blob/main/conformance/exact_multisig_vectors.json)
holds deterministic vectors for
multisig verification in the `exact` scheme, following §10.1 of the x402 XRPL
`exact` spec. They are plain data, so any implementation can run them. The
vectors, generator and runner live in the GitHub repository, not in the npm
package:

- `version` is the file format: version 2 requires a `specIdentifier` on
  every rejected case.
- `requirements` and `validatedLedgerIndex` are shared by every case.
- Each case has a `signedTxBlob`, the `accountStates` to serve from
  `fetchAccountState` (keyed by address; a missing account does not exist),
  and an `expect`: `{ "ok": true }`, or `{ "ok": false, "code": ... }` with the
  adapter's error code and the proposed §10.1 spec identifier
  (`specIdentifier`). The identifiers follow §10.1, not the adapter's codes
  one-to-one: a non-empty top-level `SigningPubKey`, more than 32 `Signers`,
  `Signers` not sorted by account ID, and the payer among its own signers are
  `invalid_transaction` in the adapter and
  `invalid_exact_xrpl_payload_multisig_signers_malformed` in the spec. A
  duplicate signer is `…_multisig_signer_not_authorized`, and a malformed
  `Signer` entry is `…_multisig_signature_invalid`, in both.
- Cases cover quorum, SignerList membership, signatures, malformed `Signer`
  entries, duplicates, key authorization (master, disabled master,
  RegularKey, and a signer account not on the ledger signing with its own or
  another key), payer existence, `Signers` order by account ID, the 32-entry cap, payer
  self-signing, and a non-empty top-level `SigningPubKey`.

Keys come from fixed test-only seeds and ed25519 signatures are
deterministic, so `pnpm vectors:exact-multisig`
([`scripts/gen-exact-multisig-vectors.ts`](https://github.com/mpcp-protocol/x402-xrpl/blob/main/scripts/gen-exact-multisig-vectors.ts))
regenerates the file byte-for-byte;
[`test/exact-vectors.test.ts`](https://github.com/mpcp-protocol/x402-xrpl/blob/main/test/exact-vectors.test.ts) checks that
and runs every case.
Never use these keys for real funds.

## Notes

- This document is included in the published package for downstream integrators.
- For normative behavior, treat `docs/SPEC.md` as the source of truth.
