/**
 * The routes and the vault's own communication DIDs. A route is a
 * reusable transport; a DID entity binds exactly one and is live while
 * its record is consistent, its document reads and sends to that
 * route, the route and any mediation behind it are usable, and the seed
 * derives its keys. The fold keeps every entity, live or not, so a key
 * name or a DID spelling met later still finds the entity it belongs
 * to; liveness governs sending and recipient registration, not history.
 */

import { IdentityMismatch, InvalidDidDocument } from "../errors.js";
import { checkDidKeys, didDocumentOf, documentSendsTo, type Keys, type RouteTarget } from "../identity.js";
import { didKeyName } from "../ids.js";
import { authorizedMethodIds, type PeerResolution } from "../peer-document.js";
import type { VaultEvent } from "../schema.js";
import type { Did, DidId, DidUrl, KeyName, MediationId, RouteId, VaultData } from "../types.js";
import type { IdentityCheck, KeyCheck, MediationFold } from "./mediation.js";
import { groupBy, samePayload, type VaultEventSet } from "./set.js";

export interface Route {
  readonly routeId: RouteId;
  /** the consistent configuration, null while there is none or configurations disagree */
  readonly configured: VaultData["route.configured"] | null;
  /** the reason of the first retirement in canonical order, null while not retired */
  readonly retired: string | null;
  /** disagreeing configurations under this ID */
  readonly conflict: boolean;
  /** configured, not retired, no conflict: what a bound DID needs of it */
  readonly usable: boolean;
  /**
   * The route or its mediation is retired or in conflict: input to a
   * DID bound here is rejected for good. A missing grant or an endpoint
   * that does not answer is not terminal.
   */
  readonly terminal: boolean;
}

export interface LocalDidEntity {
  readonly didId: DidId;
  /** the consistent creation, null while there is none or creations disagree */
  readonly created: VaultData["did.created"] | null;
  /** the long form's own document, null while it does not read */
  readonly resolution: PeerResolution | null;
  readonly keyNames: { authentication: KeyName; keyAgreement: KeyName };
  /** the document's methods for each use, for the exact `kid` a recipient or signer names */
  readonly methodIds: { authentication: readonly DidUrl[]; keyAgreement: readonly DidUrl[] };
  /** where the bound route sends, when the route and any grant behind it are known */
  readonly routeTarget: RouteTarget | null;
  readonly disclosures: readonly VaultEvent<"did.disclosed">[];
  /** the reason of the first retirement in canonical order, null while not retired */
  readonly retired: string | null;
  /** everything that keeps the entity from being live, the conflicts first */
  readonly faults: readonly string[];
  /**
   * Disagreeing creations, an unreadable record, a spelling another
   * entity also claims or keys the seed does not derive: the entity
   * cannot be used for cryptography, however its route stands.
   */
  readonly conflict: boolean;
  readonly identity: IdentityCheck;
  /** consistent, not retired, document and route in order: may send, disclose, bind and register */
  readonly live: boolean;
}

/** One pair the mediator is asked to deliver for: a live DID by its short form and its mediated route. */
export type DesiredRecipient = { did: Did; didId: DidId; routeId: RouteId; mediationId: MediationId };

export interface RouteFold {
  readonly routes: ReadonlyMap<RouteId, Route>;
  readonly dids: ReadonlyMap<DidId, LocalDidEntity>;
  /** the live DIDs on mediated routes, by short form */
  readonly desiredRecipients: readonly DesiredRecipient[];
  /** the entity a key name belongs to, retired or not; null for a name no consistent entity derives */
  entityOfKey(name: KeyName): DidId | null;
  /** the entity a spelling belongs to, short or long form; null for a spelling no consistent entity records */
  entityOfDid(did: string): DidId | null;
  /**
   * May this entity's key-agreement key still receive? `eligible` while
   * its route has no terminal dependency and the entity is live, or
   * retired but retained in a relationship's local history; `terminal`
   * for an unknown or conflicted entity, a terminal route or a retired
   * entity nothing retains; `pending` while a recoverable prerequisite
   * is missing.
   */
  receipt(didId: DidId, retainedDidIds: ReadonlySet<DidId>): ReceiptEligibility;
}

export type ReceiptEligibility = "eligible" | "pending" | "terminal";

export type RouteFoldOptions = { keyChecks?: ReadonlyMap<DidId, KeyCheck> };

export function foldRoutes(set: VaultEventSet, mediations: MediationFold, options: RouteFoldOptions = {}): RouteFold {
  const routes = foldRouteTable(set, mediations);
  const dids = foldDidTable(set, routes, mediations, options.keyChecks);

  const byKey = new Map<KeyName, DidId>();
  const byDid = new Map<string, DidId>();
  for (const did of dids.values()) {
    if (did.conflict || did.created === null) continue;
    byKey.set(did.keyNames.authentication, did.didId);
    byKey.set(did.keyNames.keyAgreement, did.didId);
    byDid.set(did.created.did, did.didId);
    byDid.set(did.created.longFormDid, did.didId);
  }

  const desiredRecipients: DesiredRecipient[] = [];
  for (const did of dids.values()) {
    if (!did.live || did.created === null) continue;
    const route = routes.get(did.created.boundRouteId)?.configured;
    if (route === undefined || route === null || route.kind !== "mediated") continue;
    desiredRecipients.push({ did: did.created.did, didId: did.didId, routeId: route.routeId, mediationId: route.mediationId });
  }
  desiredRecipients.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));

  return {
    routes,
    dids,
    desiredRecipients,
    entityOfKey: (name) => byKey.get(name) ?? null,
    entityOfDid: (did) => byDid.get(did) ?? null,
    receipt(didId, retainedDidIds) {
      const did = dids.get(didId);
      if (did === undefined || did.conflict || did.created === null) return "terminal";
      const route = routes.get(did.created.boundRouteId);
      if (route === undefined) return "pending";
      if (route.terminal || (did.retired !== null && !retainedDidIds.has(didId))) return "terminal";
      return did.faults.length === 0 ? "eligible" : "pending";
    },
  };
}

function foldRouteTable(set: VaultEventSet, mediations: MediationFold): Map<RouteId, Route> {
  const configured = groupBy(set.of("route.configured"), (event) => event.data.routeId);
  const retired = groupBy(set.of("route.retired"), (event) => event.data.routeId);
  const routes = new Map<RouteId, Route>();
  for (const routeId of [...new Set([...configured.keys(), ...retired.keys()])].sort()) {
    const configurations = configured.get(routeId) ?? [];
    const first = configurations[0]?.data ?? null;
    const conflict = first !== null && configurations.some((event) => !samePayload(event.data, first));
    const configuration = conflict ? null : first;
    const retirement = retired.get(routeId)?.[0]?.data.because ?? null;
    const mediation = configuration?.kind === "mediated" ? mediations.mediations.get(configuration.mediationId) : undefined;
    const mediationTerminal = mediation !== undefined && (mediation.status === "retired" || mediation.status === "conflict");
    routes.set(routeId, {
      routeId,
      configured: configuration,
      retired: retirement,
      conflict,
      usable: configuration !== null && retirement === null,
      terminal: retirement !== null || conflict || mediationTerminal,
    });
  }
  return routes;
}

function foldDidTable(set: VaultEventSet, routes: ReadonlyMap<RouteId, Route>, mediations: MediationFold, keyChecks: ReadonlyMap<DidId, KeyCheck> | undefined): Map<DidId, LocalDidEntity> {
  const created = groupBy(set.of("did.created"), (event) => event.data.didId);
  const disclosed = groupBy(set.of("did.disclosed"), (event) => event.data.didId);
  const retired = groupBy(set.of("did.retired"), (event) => event.data.didId);
  const ids = [...new Set([...created.keys(), ...disclosed.keys(), ...retired.keys()])].sort();

  const claimants = new Map<string, DidId[]>();
  for (const didId of ids) {
    const creation = created.get(didId)?.[0]?.data;
    if (creation === undefined) continue;
    for (const spelling of [creation.did, creation.longFormDid]) claimants.set(spelling, [...(claimants.get(spelling) ?? []), didId]);
  }

  const dids = new Map<DidId, LocalDidEntity>();
  for (const didId of ids) {
    const conflicts: string[] = [];
    const faults: string[] = [];
    const creations = created.get(didId) ?? [];
    const first = creations[0]?.data ?? null;
    if (first === null) faults.push("no creation");
    else if (creations.some((event) => !samePayload(event.data, first))) conflicts.push("creations disagree");
    const creation = conflicts.length === 0 ? first : null;

    let resolution: PeerResolution | null = null;
    if (creation !== null) {
      for (const spelling of [creation.did, creation.longFormDid]) {
        for (const other of claimants.get(spelling) ?? []) if (other !== didId) conflicts.push(`${spelling} is also entity ${other}`);
      }
      try {
        resolution = didDocumentOf(creation);
      } catch (err) {
        if (!(err instanceof InvalidDidDocument || err instanceof IdentityMismatch)) throw err;
        conflicts.push(err.message);
      }
    }
    const identity: IdentityCheck = keyChecks?.get(didId) ?? "unchecked";
    if (identity === "mismatch") conflicts.push("the seed does not derive the entity's keys");

    let routeTarget: RouteTarget | null = null;
    if (creation !== null) {
      const route = routes.get(creation.boundRouteId);
      if (route === undefined || route.configured === null) faults.push(route?.conflict === true ? "the bound route's configurations disagree" : "the bound route is not configured");
      else if (route.retired !== null) faults.push("the bound route is retired");
      if (route?.configured?.kind === "direct") routeTarget = { kind: "direct", endpoint: route.configured.endpoint };
      if (route?.configured?.kind === "mediated") {
        const mediation = mediations.mediations.get(route.configured.mediationId);
        if (mediation?.routingDid != null) routeTarget = { kind: "mediated", routingDid: mediation.routingDid };
        if (mediation?.status !== "usable") faults.push(`mediation ${route.configured.mediationId} is ${mediation?.status ?? "unknown"}`);
      }
      if (resolution !== null && routeTarget !== null && !documentSendsTo(resolution.document, routeTarget)) faults.push("the document does not send to the bound route");
    }

    const retirement = retired.get(didId)?.[0]?.data.because ?? null;
    const document = conflicts.length === 0 ? resolution : null;
    dids.set(didId, {
      didId,
      created: creation,
      resolution: document,
      keyNames: { authentication: didKeyName(didId, "authentication"), keyAgreement: didKeyName(didId, "key-agreement") },
      methodIds: {
        authentication: document === null ? [] : authorizedMethodIds(document.document, "authentication"),
        keyAgreement: document === null ? [] : authorizedMethodIds(document.document, "keyAgreement"),
      },
      routeTarget,
      disclosures: disclosed.get(didId) ?? [],
      retired: retirement,
      faults: [...conflicts, ...faults],
      conflict: conflicts.length > 0,
      identity,
      live: conflicts.length === 0 && faults.length === 0 && retirement === null,
    });
  }
  return dids;
}

/** Each consistent, readable entity checked against the seed: does its document carry the two keys its ID derives? */
export async function verifyDidKeys(keys: Keys, fold: RouteFold): Promise<Map<DidId, KeyCheck>> {
  const checks = new Map<DidId, KeyCheck>();
  for (const did of fold.dids.values()) {
    if (did.resolution === null) continue;
    try {
      await checkDidKeys(keys, did.didId, did.resolution);
      checks.set(did.didId, "verified");
    } catch (err) {
      if (!(err instanceof IdentityMismatch)) throw err;
      checks.set(did.didId, "mismatch");
    }
  }
  return checks;
}

/**
 * The mediations the runtime must keep receiving on: every usable one
 * that is preferred, or that a usable route depends on while some DID
 * bound to that route is live or is retired but retained in a
 * relationship's local history. Disclosure policy plays no part.
 */
export function requiredReceivingSet(mediations: MediationFold, routes: RouteFold, retainedDidIds: ReadonlySet<DidId> = new Set()): Set<MediationId> {
  const required = new Set<MediationId>();
  if (mediations.preferred !== null) required.add(mediations.preferred);
  for (const did of routes.dids.values()) {
    if (did.created === null || routes.receipt(did.didId, retainedDidIds) !== "eligible") continue;
    const route = routes.routes.get(did.created.boundRouteId);
    if (route?.configured?.kind !== "mediated" || !route.usable || !mediations.usable(route.configured.mediationId)) continue;
    required.add(route.configured.mediationId);
  }
  return required;
}
