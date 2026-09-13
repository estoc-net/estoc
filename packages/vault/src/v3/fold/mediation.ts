/**
 * The mediation arrangements: for each arrangement ID, the one
 * consistent creation, the one grant that makes it usable, whether it
 * has been retired, and the conflicts that make it unusable. The
 * preferred arrangement is the latest selection, when that one is
 * usable. Whether the arrangement's own DID carries the keys its name
 * derives needs the seed, so that check runs beside the fold and its
 * verdict is handed in; until it is, the arrangement is pending, since
 * nothing may receive on an identity the seed has not confirmed.
 */

import { IdentityMismatch, InvalidDidDocument } from "../errors.js";
import { checkMediationKeys, type Keys } from "../identity.js";
import { peerResolution } from "../peer-document.js";
import type { Did, KeyName, MediationId } from "../types.js";
import { groupBy, latest, samePayload, type VaultEventSet } from "./set.js";

/** Whether a recorded entity's document carries the keys the seed derives for it. */
export type KeyCheck = "verified" | "mismatch";
/** A key check's verdict as a fold carries it: `unchecked` when no seed was consulted. */
export type IdentityCheck = KeyCheck | "unchecked";

/**
 * `usable` receives; `pending` waits for its creation, its grant or
 * its key check; `retired` and `conflict` are terminal, a conflict
 * being disagreeing creations or grants, or keys the seed does not
 * derive.
 */
export type MediationStatus = "usable" | "pending" | "retired" | "conflict";

export interface Mediation {
  readonly mediationId: MediationId;
  /** the consistent creation's mediator, null while there is none or creations disagree */
  readonly mediatorDid: Did | null;
  /** the consistent creation's own identity toward the mediator */
  readonly me: { keyName: KeyName; did: Did } | null;
  /** the one granted routing DID, null while ungranted or grants disagree */
  readonly routingDid: Did | null;
  /** the reason of the first retirement in canonical order, null while not retired */
  readonly retired: string | null;
  /** what makes the arrangement a conflict: disagreeing creations or grants, or keys the seed does not derive */
  readonly faults: readonly string[];
  readonly identity: IdentityCheck;
  readonly status: MediationStatus;
}

export interface MediationFold {
  readonly mediations: ReadonlyMap<MediationId, Mediation>;
  /** the latest selection, whatever its state */
  readonly selected: MediationId | null;
  /** the latest selection when it is usable; null tells policy to select another before configuring a mediated route */
  readonly preferred: MediationId | null;
  usable(mediationId: MediationId): boolean;
}

export type MediationFoldOptions = { keyChecks?: ReadonlyMap<MediationId, KeyCheck> };

export function foldMediations(set: VaultEventSet, options: MediationFoldOptions = {}): MediationFold {
  const ids = new Set<MediationId>();
  const created = groupBy(set.of("mediation.created"), (event) => event.data.mediationId);
  const granted = groupBy(set.of("mediation.granted"), (event) => event.data.mediationId);
  const retired = groupBy(set.of("mediation.retired"), (event) => event.data.mediationId);
  for (const group of [created, granted, retired]) for (const id of group.keys()) ids.add(id);
  for (const event of set.of("mediation.selected")) ids.add(event.data.mediationId);

  const mediations = new Map<MediationId, Mediation>();
  for (const mediationId of [...ids].sort()) {
    const faults: string[] = [];
    const creations = created.get(mediationId) ?? [];
    const creation = creations[0]?.data ?? null;
    if (creation !== null && creations.some((event) => !samePayload(event.data, creation))) faults.push("creations disagree");
    const routingDids = new Set((granted.get(mediationId) ?? []).map((event) => event.data.routingDid));
    if (routingDids.size > 1) faults.push(`grants disagree: ${[...routingDids].sort().join(", ")}`);
    const identity: IdentityCheck = options.keyChecks?.get(mediationId) ?? "unchecked";
    if (identity === "mismatch") faults.push("the seed does not derive the arrangement's keys");
    const conflict = faults.length > 0;
    const retirement = retired.get(mediationId)?.[0]?.data.because ?? null;
    const routingDid = routingDids.size === 1 && !conflict ? [...routingDids][0]! : null;
    mediations.set(mediationId, {
      mediationId,
      mediatorDid: creation !== null && !conflict ? creation.mediatorDid : null,
      me: creation !== null && !conflict ? creation.me : null,
      routingDid,
      retired: retirement,
      faults,
      identity,
      status: conflict ? "conflict" : retirement !== null ? "retired" : creation === null || routingDid === null || identity === "unchecked" ? "pending" : "usable",
    });
  }

  const usable = (mediationId: MediationId) => mediations.get(mediationId)?.status === "usable";
  const selected = latest(set.of("mediation.selected"))?.data.mediationId ?? null;
  return { mediations, selected, preferred: selected !== null && usable(selected) ? selected : null, usable };
}

/** Each arrangement with a consistent creation checked against the seed: does `me.did` carry the keys its name derives? */
export async function verifyMediationKeys(keys: Keys, fold: MediationFold): Promise<Map<MediationId, KeyCheck>> {
  const checks = new Map<MediationId, KeyCheck>();
  for (const mediation of fold.mediations.values()) {
    if (mediation.me === null) continue;
    try {
      await checkMediationKeys(keys, mediation.mediationId, peerResolution(mediation.me.did));
      checks.set(mediation.mediationId, "verified");
    } catch (err) {
      if (!(err instanceof IdentityMismatch || err instanceof InvalidDidDocument)) throw err;
      checks.set(mediation.mediationId, "mismatch");
    }
  }
  return checks;
}
