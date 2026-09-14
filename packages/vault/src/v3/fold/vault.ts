/**
 * The whole fold: every fold of the package over one event set, each
 * fed the ones it reads, and what the runtime asks of them together —
 * the retention edge by edge and the roots they hold. What needs the
 * seed or the retained objects is checked once beside the fold and the
 * verdicts handed in, so the fold itself stays a pure function of the
 * set and its checks: the same set and checks give the same fold in
 * whatever order the events arrived. `scanVault` does it all over a
 * vault: one scan, the checks, the fold.
 */

import { DamagedObject, ObjectTooLarge, type Retained, type Vault, type VaultObjects } from "@estoc/event-store/v3";

import type { Keys } from "../identity.js";
import type { Cid, ContactId, DidId, EventId, MediationId, RelationshipId } from "../types.js";
import { foldAuthors, foldLabel, type AuthorActivity } from "./author.js";
import { foldContactViews, readProblemReports, type ContactView, type ProblemReport } from "./contacts.js";
import { foldErasures, heldRoots, retainedRoots, type Erasures } from "./held.js";
import { foldInbound, type InboundFold } from "./inbound.js";
import { foldInvitations, type InvitationFold } from "./invitations.js";
import { foldMediations, verifyMediationKeys, type KeyCheck, type MediationFold } from "./mediation.js";
import { foldOutbound, type OutboundFold } from "./outbound.js";
import { foldProfiles, type Profile } from "./profile.js";
import { foldRelationships, verifyResolutions, verifyTransitions, type EvidenceCheck, type ReadObject, type RelationshipFold } from "./relationships.js";
import { foldRoutes, verifyDidKeys, type RouteFold } from "./routes.js";
import { VaultEventSet } from "./set.js";

/** The verdicts a fold cannot reach on its own: the seed's on each entity, the retained documents' on each snapshot and proof, the objects' on each problem report. */
export type VaultChecks = {
  mediationKeys?: ReadonlyMap<MediationId, KeyCheck>;
  didKeys?: ReadonlyMap<DidId, KeyCheck>;
  resolutionChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  proofChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  problemReports?: ReadonlyMap<EventId, ProblemReport>;
};

export interface VaultFold {
  readonly set: VaultEventSet;
  readonly checks: Required<VaultChecks>;
  readonly label: string | null;
  readonly authors: readonly AuthorActivity[];
  readonly mediations: MediationFold;
  readonly routes: RouteFold;
  readonly invitations: InvitationFold;
  readonly relationships: RelationshipFold;
  readonly inbound: InboundFold;
  readonly outbound: OutboundFold;
  readonly erasures: Erasures;
  readonly profiles: ReadonlyMap<RelationshipId, Profile>;
  readonly contacts: ReadonlyMap<ContactId, ContactView>;
  /** each accepted event with each root it still retains */
  readonly retained: readonly Retained[];
  /** the roots `retained` holds: what collection keeps and an export copies */
  readonly held: ReadonlySet<Cid>;
}

export function foldVault(set: VaultEventSet, checks: VaultChecks = {}): VaultFold {
  const all: Required<VaultChecks> = {
    mediationKeys: checks.mediationKeys ?? new Map(),
    didKeys: checks.didKeys ?? new Map(),
    resolutionChecks: checks.resolutionChecks ?? new Map(),
    proofChecks: checks.proofChecks ?? new Map(),
    problemReports: checks.problemReports ?? new Map(),
  };
  const mediations = foldMediations(set, { keyChecks: all.mediationKeys });
  const routes = foldRoutes(set, mediations, { keyChecks: all.didKeys });
  const relationships = foldRelationships(set, routes, { proofChecks: all.proofChecks, resolutionChecks: all.resolutionChecks });
  const inbound = foldInbound(set, relationships);
  const erasures = foldErasures(set);
  const outbound = foldOutbound(set, routes, relationships, inbound, { resolutionChecks: all.resolutionChecks, erasures });
  const profiles = foldProfiles(set, relationships, inbound, outbound);
  const contacts = foldContactViews(set, { routes, relationships, inbound, outbound, profiles }, { problemReports: all.problemReports, erasures });
  const retained = retainedRoots(set, outbound, erasures);
  return {
    set,
    checks: all,
    label: foldLabel(set),
    authors: foldAuthors(set),
    mediations,
    routes,
    invitations: foldInvitations(set, routes),
    relationships,
    inbound,
    outbound,
    erasures,
    profiles,
    contacts,
    retained,
    held: heldRoots(set, outbound, erasures),
  };
}

/** The largest object a reader beside the fold takes: a peer document or a problem report, never a message body of any size. */
export const MAX_READ_BYTES = 1024 * 1024;

/**
 * A `ReadObject` over a vault's objects: the bytes of an object that is
 * here, null for one that is absent, known damaged or larger than
 * `maxBytes`, since none of those is evidence — what rests on it stays
 * deferred until a repair or an import brings the object.
 */
export function objectReader(objects: VaultObjects, maxBytes = MAX_READ_BYTES): ReadObject {
  return async (cid) => {
    try {
      return await objects.read(cid, maxBytes);
    } catch (err) {
      if (err instanceof DamagedObject || err instanceof ObjectTooLarge) return null;
      throw err;
    }
  };
}

/**
 * Every check beside the fold: the seed's verdict on each mediation
 * and DID entity when the keys are here, no verdict otherwise; each
 * resolution's snapshot and each transition's proof against the
 * retained documents; each problem report's body.
 */
export async function checkVault(set: VaultEventSet, keys: Keys | null, readObject: ReadObject): Promise<Required<VaultChecks>> {
  const mediationKeys = keys === null ? new Map<MediationId, KeyCheck>() : await verifyMediationKeys(keys, foldMediations(set));
  const mediations = foldMediations(set, { keyChecks: mediationKeys });
  const didKeys = keys === null ? new Map<DidId, KeyCheck>() : await verifyDidKeys(keys, foldRoutes(set, mediations));
  const routes = foldRoutes(set, mediations, { keyChecks: didKeys });
  const [resolutionChecks, proofChecks, problemReports] = await Promise.all([verifyResolutions(set, readObject), verifyTransitions(set, routes, readObject), readProblemReports(set, readObject)]);
  return { mediationKeys, didKeys, resolutionChecks, proofChecks, problemReports };
}

export async function foldVaultChecked(set: VaultEventSet, keys: Keys | null, readObject: ReadObject): Promise<VaultFold> {
  return foldVault(set, await checkVault(set, keys, readObject));
}

export type ScanOptions = {
  /** the largest object read beside the fold; `MAX_READ_BYTES` when left out */
  maxObjectBytes?: number;
};

/** One scan of the vault's events, the checks against its objects and the seed, the fold: what the runtime reads on open and under every locked operation. */
export async function scanVault(vault: Vault, keys: Keys | null, options: ScanOptions = {}): Promise<VaultFold> {
  const set = await VaultEventSet.from(vault.events.scan());
  return foldVaultChecked(set, keys, objectReader(vault.objects, options.maxObjectBytes));
}
