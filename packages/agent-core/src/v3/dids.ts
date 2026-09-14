/**
 * Routes and communication DIDs: a route configured once over a
 * mediation or a direct endpoint and bound by any number of DIDs; a
 * DID entity minted from its ID and its route alone, so a committed ID
 * reuses its exact keys and document after a crash and cannot be
 * recreated on another route; the disclosure that reveals an address,
 * its mediated registration verified first; and the retirement that
 * ends new sending, disclosure and births at it. Every decision is
 * taken over the fold under the lock.
 */

import { v7 as uuidv7 } from "uuid";

import type { VaultRuntime } from "@estoc/event-store/v3";
import {
  mintDid,
  scanVault,
  vaultDraft,
  type Did,
  type DidId,
  type DisclosureAs,
  type DisclosureUses,
  type Keys,
  type LocalDidEntity,
  type MediationId,
  type MintedDid,
  type Route,
  type RouteId,
  type RouteTarget,
  type VaultData,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { PLAIN_TYP } from "../protocol/didcomm.js";
import { GOAL_CONNECT, type Invitation } from "../protocol/oob.js";
import { OOB_INVITATION } from "../protocol/spec.js";
import { EntityConflict, UnknownEntity, Unregistered, Unusable, WrongMediator } from "./errors.js";
import type { MediatorLink } from "./link.js";
import { mediationOf, reconcile, registered } from "./mediation.js";
import { decide } from "./procedure.js";

export type RouteSpec = { kind: "mediated"; mediationId: MediationId } | { kind: "direct"; endpoint: string };

/** The route as the fold has it; `UnknownEntity` when it has none. */
export function routeOf(fold: VaultFold, routeId: RouteId): Route {
  const route = fold.routes.routes.get(routeId);
  if (route === undefined) throw new UnknownEntity("route", routeId);
  return route;
}

/** The DID entity as the fold has it; `UnknownEntity` when it has none. */
export function didOf(fold: VaultFold, didId: DidId): LocalDidEntity {
  const entity = fold.routes.dids.get(didId);
  if (entity === undefined) throw new UnknownEntity("DID", didId);
  return entity;
}

/** Where a usable route sends: the mediation's routing DID, or the endpoint. `Unusable` for a route that is not configured, is retired, or whose mediation is not usable. */
export function routeTargetOf(fold: VaultFold, routeId: RouteId): RouteTarget {
  const route = routeOf(fold, routeId);
  if (!route.usable || route.configured === null) throw new Unusable("route", routeId, route.conflict ? ["configurations disagree"] : route.retired !== null ? [`retired: ${route.retired}`] : ["not configured"]);
  if (route.configured.kind === "direct") return { kind: "direct", endpoint: route.configured.endpoint };
  const mediation = mediationOf(fold, route.configured.mediationId);
  if (mediation.status !== "usable" || mediation.routingDid === null) throw new Unusable("route", routeId, [`mediation ${mediation.mediationId} is ${mediation.status}`]);
  return { kind: "mediated", routingDid: mediation.routingDid };
}

/**
 * `route.configured` over a usable mediation or a direct endpoint. The
 * same ID again returns the configuration already recorded when it
 * says the same, and refuses one that says otherwise.
 */
export async function configureRoute(runtime: VaultRuntime, keys: Keys, spec: RouteSpec, routeId = uuidv7() as RouteId): Promise<VaultEvent<"route.configured">> {
  const data: VaultData["route.configured"] = spec.kind === "mediated" ? { routeId, kind: "mediated", mediationId: spec.mediationId, endpoint: null } : { routeId, kind: "direct", mediationId: null, endpoint: spec.endpoint };
  const { fold, events } = await decide(runtime, keys, (fold) => {
    const existing = fold.routes.routes.get(routeId);
    if (existing !== undefined) {
      if (existing.configured === null || existing.configured.kind !== data.kind || existing.configured.mediationId !== data.mediationId || existing.configured.endpoint !== data.endpoint) {
        throw new EntityConflict("route", routeId, existing.conflict ? "configurations disagree" : "another configuration");
      }
      return [];
    }
    if (spec.kind === "mediated") {
      const mediation = mediationOf(fold, spec.mediationId);
      if (mediation.status !== "usable") throw new Unusable("mediation", spec.mediationId, mediation.faults.length > 0 ? mediation.faults : [mediation.status]);
    }
    return [vaultDraft("route.configured", data)];
  });
  return (events[0] as VaultEvent<"route.configured"> | undefined) ?? (fold.set.of("route.configured").find((event) => event.data.routeId === routeId) as VaultEvent<"route.configured">);
}

/** The first usable route over `mediationId` by ID, or null. */
export function mediatedRouteOf(fold: VaultFold, mediationId: MediationId): Route | null {
  for (const route of fold.routes.routes.values()) {
    if (route.usable && route.configured?.kind === "mediated" && route.configured.mediationId === mediationId) return route;
  }
  return null;
}

/** A usable route over `mediationId`: the one there is, or one configured now. */
export async function ensureRoute(runtime: VaultRuntime, keys: Keys, mediationId: MediationId): Promise<RouteId> {
  const have = mediatedRouteOf(await scanVault(runtime.vault, keys), mediationId);
  return have?.routeId ?? (await configureRoute(runtime, keys, { kind: "mediated", mediationId })).data.routeId;
}

export interface CreatedDid {
  created: VaultEvent<"did.created">;
  minted: MintedDid;
  /** the entity was recorded already, with exactly this document and route: nothing was written */
  existed: boolean;
}

/**
 * `did.created` on a usable route: the fixed keys derived from the
 * entity ID, the numalgo-4 document built over them and the route's
 * target, the short form, long form and route committed. The same ID
 * again returns what was recorded when the seed and route give the
 * same document; an entity that would differ, or one in conflict, is
 * refused rather than replaced.
 */
export async function createDid(runtime: VaultRuntime, keys: Keys, routeId: RouteId, didId = uuidv7() as DidId): Promise<CreatedDid> {
  let minted!: MintedDid;
  const { fold, events } = await decide(runtime, keys, async (fold) => {
    minted = await mintDid(keys, didId, routeTargetOf(fold, routeId));
    const existing = fold.routes.dids.get(didId);
    if (existing !== undefined) {
      const same = existing.created !== null && existing.created.did === minted.did && existing.created.longFormDid === minted.longFormDid && existing.created.boundRouteId === routeId;
      if (!same) throw new EntityConflict("DID", didId, existing.conflict ? existing.faults.join("; ") : "another document or route");
      return [];
    }
    return [vaultDraft("did.created", { didId, did: minted.did, longFormDid: minted.longFormDid, boundRouteId: routeId })];
  });
  const created = events[0] as VaultEvent<"did.created"> | undefined;
  return created === undefined
    ? { created: fold.set.of("did.created").find((event) => event.data.didId === didId) as VaultEvent<"did.created">, minted, existed: true }
    : { created, minted, existed: false };
}

export interface Disclosure {
  as: DisclosureAs;
  uses: DisclosureUses;
  goal?: string | null;
  /** the invitation's ID, for an `oob` disclosure; a fresh UUIDv7 when left out */
  oobId?: string;
}

export interface Disclosed {
  disclosed: VaultEvent<"did.disclosed">;
  /** the entity's long form: what the disclosure exposes */
  longFormDid: Did;
  /** the out-of-band invitation an `oob` disclosure is carried by; null for the other kinds */
  invitation: Invitation | null;
}

/** The out-of-band invitation that discloses `longFormDid` under `oobId`. */
export function invitationOf(longFormDid: Did, oobId: string, goal: string | null): Invitation {
  return { type: OOB_INVITATION, id: oobId, typ: PLAIN_TYP, from: longFormDid, body: { goal_code: GOAL_CONNECT, ...(goal === null ? {} : { goal }), accept: ["didcomm/v2"] } };
}

function requireLive(entity: LocalDidEntity): void {
  if (!entity.live) throw new Unusable("DID", entity.didId, entity.retired !== null ? [`retired: ${entity.retired}`, ...entity.faults] : entity.faults);
}

/**
 * `did.disclosed` for a live entity, and the invitation when it is an
 * `oob` one. A mediated address is reconciled with its mediator over
 * `link` first and refused unless the mediator holds it; a direct
 * address needs no link. The reconciliation runs outside the lock,
 * the entity's liveness is read again under it.
 */
export async function disclose(link: MediatorLink | null, runtime: VaultRuntime, keys: Keys, didId: DidId, disclosure: Disclosure): Promise<Disclosed> {
  const fold = await scanVault(runtime.vault, keys);
  const entity = didOf(fold, didId);
  requireLive(entity);
  const created = entity.created as VaultData["did.created"];
  const route = routeOf(fold, created.boundRouteId);
  if (route.configured?.kind === "mediated") {
    const mediation = mediationOf(fold, route.configured.mediationId);
    if (link === null) throw new WrongMediator(mediation.mediatorDid ?? "unknown", "no link");
    if (!registered(await reconcile(link, fold, mediation.mediationId), created.did)) throw new Unregistered(created.did);
  }
  const goal = disclosure.goal ?? null;
  const oobId = disclosure.as === "oob" ? (disclosure.oobId ?? uuidv7()) : null;
  const { events } = await decide(runtime, keys, (fold) => {
    requireLive(didOf(fold, didId));
    return [vaultDraft("did.disclosed", { didId, as: disclosure.as, uses: disclosure.uses, oobId, goal })];
  });
  return { disclosed: events[0] as VaultEvent<"did.disclosed">, longFormDid: created.longFormDid, invitation: oobId === null ? null : invitationOf(created.longFormDid, oobId, goal) };
}

/** `did.retired` for an entity, `because`: terminal for new sending, disclosure and births. Already retired, the first retirement is returned and nothing written. */
export async function retireDid(runtime: VaultRuntime, keys: Keys, didId: DidId, because: string): Promise<VaultEvent<"did.retired">> {
  const { fold, events } = await decide(runtime, keys, (fold) => (didOf(fold, didId).retired === null ? [vaultDraft("did.retired", { didId, because })] : []));
  return (events[0] as VaultEvent<"did.retired"> | undefined) ?? (fold.set.of("did.retired").find((event) => event.data.didId === didId) as VaultEvent<"did.retired">);
}
