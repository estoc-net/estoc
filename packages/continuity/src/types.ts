/** An already validated canonical DID: the model compares it byte for byte and never parses it. */
export type Did = string;

/** A host-allocated, replica-stable identifier of one immutable fact value. */
export type FactId = string;

/** A host-allocated, replica-stable reference to one immutable piece of evidence: a receipt, a saved decision. */
export type EvidenceRef = string;

/** An oriented pair with fixed roles; rotation makes another channel rather than rewriting this one. */
export type Channel = Readonly<{ localDid: Did; peerDid: Did }>;

export type Change = Readonly<{ kind: "rotate"; successor: Did }> | Readonly<{ kind: "end" }>;

/** A verified and bound declaration by the peer of `at` that it rotated to `successor`, or ended, in that pair. */
export type PeerTransition = Readonly<{
  kind: "peer-transition";
  id: FactId;
  at: Channel;
  change: Change;
  receipt: EvidenceRef;
}>;

/**
 * A saved local choice to rotate the local DID of `at`, or to end there.
 * For a rotation, `source` names the exact observation the host selected
 * as confirming the predecessor address, and null lets the model find
 * any. An ending confirms no address: its `source` is null.
 */
export type LocalDecision = Readonly<{
  kind: "local-decision";
  id: FactId;
  at: Channel;
  change: Change;
  source: FactId | null;
  decision: EvidenceRef;
}>;

/**
 * One authenticated receipt from the peer of `at` to exactly its local
 * DID. `carriedTransition` names the peer transition the same receipt
 * carried; null means the receipt carried no proof at all.
 */
export type AddressObservation = Readonly<{
  kind: "address-observed";
  id: FactId;
  at: Channel;
  carriedTransition: FactId | null;
  receipt: EvidenceRef;
}>;

export type ContinuityFact = PeerTransition | LocalDecision | AddressObservation;

/** The fact schema, normalization, proof rules and derivation rules this package implements. */
export const PROFILE_VERSION = "estoc-continuity/1";

/**
 * The facts of one logical local identity. Facts may repeat an ID with
 * different values: the merge contract retains every variant.
 */
export type FactSnapshot = Readonly<{
  identityNamespace: string;
  profileVersion: string;
  facts: readonly ContinuityFact[];
}>;
