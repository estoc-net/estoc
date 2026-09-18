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
import type { Cid, DidId, EventId, MediationId } from "../types.js";
import { foldAuthors, foldLabel, type AuthorActivity } from "./author.js";
import { foldChannelEvidence, verifyProofs, type ChannelEvidence } from "./channels.js";
import { foldContacts, type ContactFold } from "./contacts.js";
import { foldContinuity, type Continuity } from "./continuity.js";
import { verifyResolutions, type EvidenceCheck, type ReadObject } from "./evidence.js";
import { foldErasures, heldRoots, retainedRoots, type Erasures } from "./held.js";
import { foldInbound, type InboundFold } from "./inbound.js";
import { foldInvitations, type InvitationFold } from "./invitations.js";
import { foldMediations, verifyMediationKeys, type KeyCheck, type MediationFold } from "./mediation.js";
import { foldOutbound, type OutboundFold, type OutboundFoldOptions } from "./outbound.js";
import { foldRoutes, verifyDidKeys, type RouteFold } from "./routes.js";
import { VaultEventSet } from "./set.js";

/** The verdicts a fold cannot reach on its own: the seed's on each entity, the retained documents' on each snapshot and on each proof. */
export type VaultChecks = {
  mediationKeys?: ReadonlyMap<MediationId, KeyCheck>;
  didKeys?: ReadonlyMap<DidId, KeyCheck>;
  resolutionChecks?: ReadonlyMap<EventId, EvidenceCheck>;
  proofChecks?: ReadonlyMap<EventId, EvidenceCheck>;
};

export interface VaultFold {
  readonly set: VaultEventSet;
  readonly checks: Required<VaultChecks>;
  readonly label: string | null;
  readonly authors: readonly AuthorActivity[];
  readonly mediations: MediationFold;
  readonly routes: RouteFold;
  readonly channels: ChannelEvidence;
  readonly continuity: Continuity;
  readonly inbound: InboundFold;
  readonly invitations: InvitationFold;
  readonly contacts: ContactFold;
  readonly outbound: OutboundFold;
  readonly erasures: Erasures;
  /** each accepted event with each root it still retains */
  readonly retained: readonly Retained[];
  /** the roots `retained` holds: what collection keeps and an export copies */
  readonly held: ReadonlySet<Cid>;
}

export type FoldOptions = OutboundFoldOptions;

export function foldVault(set: VaultEventSet, checks: VaultChecks = {}, options: FoldOptions = {}): VaultFold {
  const all: Required<VaultChecks> = {
    mediationKeys: checks.mediationKeys ?? new Map(),
    didKeys: checks.didKeys ?? new Map(),
    resolutionChecks: checks.resolutionChecks ?? new Map(),
    proofChecks: checks.proofChecks ?? new Map(),
  };
  const mediations = foldMediations(set, { keyChecks: all.mediationKeys });
  const routes = foldRoutes(set, mediations, { keyChecks: all.didKeys });
  const channels = foldChannelEvidence(set, routes, all);
  const continuity = foldContinuity(set, channels);
  const erasures = foldErasures(set);
  const inbound = foldInbound(channels, continuity, erasures);
  const outbound = foldOutbound(set, routes, channels, continuity, inbound, erasures, all.resolutionChecks, options);
  return {
    set,
    checks: all,
    label: foldLabel(set),
    authors: foldAuthors(set),
    mediations,
    routes,
    channels,
    continuity,
    inbound,
    invitations: foldInvitations(set, routes, channels, continuity, inbound, erasures),
    contacts: foldContacts(set),
    outbound,
    erasures,
    retained: retainedRoots(set, erasures, outbound.released),
    held: heldRoots(set, erasures, outbound.released),
  };
}

/** The largest object a reader beside the fold takes: a peer document, never a message body of any size. */
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
 * resolution's snapshot against the retained documents; each proof
 * against the issuer's document those snapshots retain or its long
 * form derives.
 */
export async function checkVault(set: VaultEventSet, keys: Keys | null, readObject: ReadObject): Promise<Required<VaultChecks>> {
  const mediationKeys = keys === null ? new Map<MediationId, KeyCheck>() : await verifyMediationKeys(keys, foldMediations(set));
  const mediations = foldMediations(set, { keyChecks: mediationKeys });
  const didKeys = keys === null ? new Map<DidId, KeyCheck>() : await verifyDidKeys(keys, foldRoutes(set, mediations));
  const resolutionChecks = await verifyResolutions(set, readObject);
  return { mediationKeys, didKeys, resolutionChecks, proofChecks: await verifyProofs(set, resolutionChecks, readObject) };
}

export async function foldVaultChecked(set: VaultEventSet, keys: Keys | null, readObject: ReadObject, options: FoldOptions = {}): Promise<VaultFold> {
  return foldVault(set, await checkVault(set, keys, readObject), options);
}

export type ScanOptions = FoldOptions & {
  /** the largest object read beside the fold; `MAX_READ_BYTES` when left out */
  maxObjectBytes?: number;
};

/** One scan of the vault's events, the checks against its objects and the seed, the fold: what the runtime reads on open and under every locked operation. */
export async function scanVault(vault: Vault, keys: Keys | null, options: ScanOptions = {}): Promise<VaultFold> {
  const set = await VaultEventSet.from(vault.events.scan());
  return foldVaultChecked(set, keys, objectReader(vault.objects, options.maxObjectBytes), options);
}
