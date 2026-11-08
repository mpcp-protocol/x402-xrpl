# Conformance

This package targets the XRPL adapter specification in `docs/SPEC.md`.

## Current status

- Core settlement verification invariants are covered in tests under `test/`.
- `exact` multisig verification is covered by deterministic conformance vectors (below).
- Replay/idempotency behavior is validated with mocked transaction fetches.
- Error code semantics include challenge, receipt, memo, and replay classes.

## `exact` multisig vectors

`conformance/exact_multisig_vectors.json` holds deterministic vectors for
multisig verification in the `exact` scheme, following §10.1 of the x402 XRPL
`exact` spec. They are plain data, so any implementation can run them:

- `requirements` and `validatedLedgerIndex` are shared by every case.
- Each case has a `signedTxBlob`, the `accountStates` to serve from
  `fetchAccountState` (keyed by address; a missing account does not exist),
  and an `expect`: `{ "ok": true }`, or `{ "ok": false, "code": ... }` with the
  adapter's error code and, where §10.1 defines one, the proposed spec
  identifier (`specIdentifier`).
- Cases cover quorum, SignerList membership, signatures, duplicates, key
  authorization (master, disabled master, RegularKey, unfunded signer), payer
  existence, `Signers` order by account ID, the 32-entry cap, payer
  self-signing, and a non-empty top-level `SigningPubKey`.

Keys come from fixed test-only seeds and ed25519 signatures are
deterministic, so `pnpm vectors:exact-multisig` regenerates the file
byte-for-byte; `test/exact-vectors.test.ts` checks that and runs every case.
Never use these keys for real funds.

## Notes

- This document is included in the published package for downstream integrators.
- For normative behavior, treat `docs/SPEC.md` as the source of truth.
