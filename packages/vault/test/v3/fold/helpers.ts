import type { AuthorId, Event, EventId } from "@estoc/event-store/v3";
import { importSeed } from "@estoc/keystore";
import { expect } from "vitest";
import { v7 as uuidv7 } from "uuid";

import {
  Keys,
  VaultEventSet,
  foldMediations,
  foldRoutes,
  mintDid,
  rawCidOfBytes,
  vaultDraft,
  type Did,
  type DidId,
  type KeyName,
  type MediationId,
  type RouteId,
  type KeyCheck,
  type MediationFold,
  type RouteFold,
  type RouteTarget,
  type VaultData,
  type VaultEvent,
  type VaultEventType,
  verifyDidKeys,
  verifyMediationKeys,
} from "../../../src/v3/index.js";

export const SEED = new Uint8Array(32).fill(7);
export const OTHER_SEED = new Uint8Array(32).fill(8);
export const AUTHOR = "019b2a40-0000-7000-8000-000000000001" as AuthorId;
export const AUTHOR2 = "019b2a40-0000-7000-8000-000000000002" as AuthorId;
export const MEDIATION = "019b2a51-118f-7e46-b31b-c63cd090c92c" as MediationId;
export const MEDIATION2 = "019b2a52-3c11-7a08-9d55-0f40b1a3e2d7" as MediationId;
export const ROUTE = "019b2a58-fef5-7d59-ae1c-46e4f0a13c73" as RouteId;
export const ROUTE2 = "019b2a59-0a21-7b3e-8c1d-5e6f7a8b9c0d" as RouteId;
export const DID_ID = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
export const DID_ID2 = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
export const DID_ID3 = "019b6a10-12c0-7410-89ab-38e54b097c21" as DidId;
export const ROUTING_DID = "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" as Did;
export const ROUTING_DID2 = "did:peer:2.Ez6LSghwSE437wnDE1pt3X6hVDUQzSjsHzinpX3XFvMjRAm7y" as Did;
export const ENDPOINT = "https://ingress.example/didcomm";
export const MEDIATED: RouteTarget = { kind: "mediated", routingDid: ROUTING_DID };
export const DIRECT: RouteTarget = { kind: "direct", endpoint: ENDPOINT };
export const HASH = "hmqd2ObLCbE6Ru94DITHwte-8oYqrtNZgPxiv7WfXAA";

const encoder = new TextEncoder();
export const cidOf = (text: string) => rawCidOfBytes(encoder.encode(text));

export async function openKeys(seed = SEED): Promise<Keys> {
  const seedKey = await importSeed(seed);
  return Keys.open(seedKey, await Keys.anchorOf(seedKey));
}

export type Clock = { next(): string };

/** Wall-clock stamps one millisecond apart, so canonical order follows the order of minting unless a test says otherwise. */
export function clock(start = Date.UTC(2026, 8, 13)): Clock {
  let t = start;
  return { next: () => new Date(t++).toISOString() };
}

export type EventOptions = { at?: string; author?: AuthorId; eventId?: EventId };

/** A scene: events built in order, each a millisecond after the last, checked against its schema. */
export class Scene {
  readonly events: Event[] = [];
  private readonly clock = clock();

  add<T extends VaultEventType>(type: T, data: VaultData[T], options: EventOptions = {}): VaultEvent<T> {
    const draft = vaultDraft(type, data);
    const event = {
      eventId: options.eventId ?? (uuidv7() as EventId),
      at: options.at ?? this.clock.next(),
      author: options.author ?? AUTHOR,
      type,
      roots: draft.roots,
      data: draft.data,
    } as VaultEvent<T>;
    this.events.push(event);
    return event;
  }

  /** An event of a type this version does not name. */
  foreign(type: string, data: Record<string, unknown> = {}, options: EventOptions = {}): Event {
    const event = { eventId: options.eventId ?? (uuidv7() as EventId), at: options.at ?? this.clock.next(), author: options.author ?? AUTHOR, type, roots: [], data } as Event;
    this.events.push(event);
    return event;
  }

  set(): VaultEventSet {
    return VaultEventSet.of(this.events);
  }
}

/** A deterministic Fisher–Yates over a copy: the same seed, the same permutation. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A fold result as comparable JSON: maps and sets by sorted entries, functions dropped, a bigint as its digits. */
export function snapshot(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) => {
    if (v instanceof Map) return Object.fromEntries([...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)));
    if (v instanceof Set) return [...v].sort();
    if (typeof v === "function") return undefined;
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof Uint8Array) return Array.from(v);
    return v;
  });
}

/** The fold gives the same result over several deterministic shuffles of the events. */
export function expectOrderFree(events: readonly Event[], fold: (set: VaultEventSet) => unknown, permutations = 6): void {
  const expected = snapshot(fold(VaultEventSet.of(events)));
  for (let seed = 1; seed <= permutations; seed++) {
    expect(snapshot(fold(VaultEventSet.of(shuffled(events, seed))))).toBe(expected);
  }
}

/** A mediation created, granted and selected, and a mediated route over it. */
export function mediatedRoute(scene: Scene, keys: { me: Did }, mediationId = MEDIATION, routeId = ROUTE, routingDid = ROUTING_DID): void {
  scene.add("mediation.created", { mediationId, mediatorDid: "did:web:mediator.example" as Did, me: { keyName: `mediation/${mediationId}/me` as KeyName, did: keys.me } });
  scene.add("mediation.granted", { mediationId, routingDid });
  scene.add("mediation.selected", { mediationId });
  scene.add("route.configured", { routeId, kind: "mediated", mediationId, endpoint: null });
}

/** A communication DID minted from the seed on a route, recorded as `did.created`. */
export async function createdDid(scene: Scene, keys: Keys, didId: DidId, routeId: RouteId, target: RouteTarget): Promise<VaultData["did.created"]> {
  const minted = await mintDid(keys, didId, target);
  const data = { didId, did: minted.did, longFormDid: minted.longFormDid, boundRouteId: routeId };
  scene.add("did.created", data);
  return data;
}

export type KeyChecks = { mediations: Map<MediationId, KeyCheck>; dids: Map<DidId, KeyCheck> };

/** The seed's verdict on every entity of the scene, computed once: the checks depend on the set, not on its order. */
export async function checksOf(events: readonly Event[], keys: Keys): Promise<KeyChecks> {
  const set = VaultEventSet.of(events);
  const mediations = await verifyMediationKeys(keys, foldMediations(set));
  const dids = await verifyDidKeys(keys, foldRoutes(set, foldMediations(set, { keyChecks: mediations })));
  return { mediations, dids };
}

/** The mediation and route folds over a set, with the verdicts given. */
export function foldChecked(set: VaultEventSet, checks: KeyChecks): { mediations: MediationFold; routes: RouteFold } {
  const mediations = foldMediations(set, { keyChecks: checks.mediations });
  return { mediations, routes: foldRoutes(set, mediations, { keyChecks: checks.dids }) };
}
