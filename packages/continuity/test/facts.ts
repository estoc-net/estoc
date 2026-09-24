import type { AddressObservation, Channel, ContinuityFact, Did, FactId, FactSnapshot, LocalDecision, PeerTransition } from "../src/index.js";
import { PROFILE_VERSION } from "../src/index.js";

export const C = (localDid: Did, peerDid: Did): Channel => ({ localDid, peerDid });

export const rotate = (id: FactId, at: Channel, successor: Did, receipt = `receipt-${id}`): PeerTransition => ({ kind: "peer-transition", id, at, change: { kind: "rotate", successor }, receipt });

export const peerEnd = (id: FactId, at: Channel, receipt = `receipt-${id}`): PeerTransition => ({ kind: "peer-transition", id, at, change: { kind: "end" }, receipt });

export const decide = (id: FactId, at: Channel, successor: Did, source: FactId | null = null, decision = `decision-${id}`): LocalDecision => ({ kind: "local-decision", id, at, change: { kind: "rotate", successor }, source, decision });

export const localEnd = (id: FactId, at: Channel, decision = `decision-${id}`): LocalDecision => ({ kind: "local-decision", id, at, change: { kind: "end" }, source: null, decision });

export const observe = (id: FactId, at: Channel, carriedTransition: FactId | null = null, receipt = `receipt-${id}`): AddressObservation => ({ kind: "address-observed", id, at, carriedTransition, receipt });

export const snapshot = (facts: readonly ContinuityFact[], identityNamespace = "alice"): FactSnapshot => ({ identityNamespace, profileVersion: PROFILE_VERSION, facts });

/** Every permutation of a short array. */
export function* permutations<T>(items: readonly T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i]!, ...tail];
  }
}
