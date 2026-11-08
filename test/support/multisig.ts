/**
 * Wallet and multisigning helpers shared by the unit tests and the
 * conformance vector generator (scripts/gen-exact-multisig-vectors.ts).
 * Test-only: never use these helpers or their keys for real funds.
 */
import { encode, encodeForMultisigning } from "ripple-binary-codec";
import {
  deriveAddress,
  deriveKeypair,
  generateSeed,
  sign,
} from "ripple-keypairs";
import { decodeAccountID } from "ripple-address-codec";

export interface Wallet {
  address: string;
  publicKey: string;
  privateKey: string;
}
export type Tx = Record<string, unknown>;

/** Wallet from `seed`, or from a fresh random ed25519 seed. */
export function wallet(seed = generateSeed({ algorithm: "ed25519" })): Wallet {
  const kp = deriveKeypair(seed);
  return {
    address: deriveAddress(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  };
}

/** Compares two addresses by account ID, the order rippled requires for `Signers`. */
export function compareByAccountId(a: string, b: string): number {
  return Buffer.compare(
    Buffer.from(decodeAccountID(a)),
    Buffer.from(decodeAccountID(b)),
  );
}
/** Orders wallets by account ID. */
export function byAccountId(a: Wallet, b: Wallet): number {
  return compareByAccountId(a.address, b.address);
}

/**
 * A multisig signer: a wallet signing for its own account, or `key` signing
 * for another account `as` (e.g. that account's RegularKey).
 */
export type SignerSpec = Wallet | { as: string; key: Wallet };

/**
 * Multisigns `tx`. `Signers` are sorted by account ID, as xrpl.js does,
 * unless `keepOrder` is set.
 */
export function multiSigned(
  tx: Tx,
  signers: SignerSpec[],
  { keepOrder = false }: { keepOrder?: boolean } = {},
): string {
  const unsigned = { ...tx, SigningPubKey: "" };
  const entries = signers.map((s) =>
    "as" in s ? { account: s.as, key: s.key } : { account: s.address, key: s },
  );
  if (!keepOrder)
    entries.sort((a, b) => compareByAccountId(a.account, b.account));
  const Signers = entries.map(({ account, key }) => ({
    Signer: {
      Account: account,
      SigningPubKey: key.publicKey,
      TxnSignature: sign(
        encodeForMultisigning(unsigned as never, account),
        key.privateKey,
      ),
    },
  }));
  return encode({ ...unsigned, Signers } as never);
}
