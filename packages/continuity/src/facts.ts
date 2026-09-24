/**
 * The fact schema and its canonical form. A fact is admitted by reading
 * every member once into a fresh value, so nothing a caller passed can
 * answer differently later; equality is the RFC 8785 serialization of
 * that value, which orders members but keeps every string exact.
 */

import serialize from "canonicalize";

import { InvalidFact } from "./errors.js";
import type { AddressObservation, Change, Channel, ContinuityFact, Did, FactId, LocalDecision, PeerTransition } from "./types.js";

const FACT_KEYS: Record<ContinuityFact["kind"], readonly string[]> = {
  "peer-transition": ["kind", "id", "at", "change", "receipt"],
  "local-decision": ["kind", "id", "at", "change", "source", "decision"],
  "address-observed": ["kind", "id", "at", "carriedTransition", "receipt"],
};

// I-JSON keeps a lone surrogate out of a string; RFC 8785 has no
// serialization for one that both sides agree on.
const LONE_SURROGATE = /\p{Cs}/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], where: string): void {
  const keys = Object.keys(value);
  for (const key of expected) if (!(key in value)) throw new InvalidFact(`${where} lacks ${key}`);
  for (const key of keys) if (!expected.includes(key)) throw new InvalidFact(`${where} has an unknown member ${JSON.stringify(key)}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) throw new InvalidFact(`${where} is a non-empty string`);
  if (LONE_SURROGATE.test(value)) throw new InvalidFact(`${where} has an unpaired surrogate`);
  return value;
}

function textOrNull(value: unknown, where: string): string | null {
  return value === null ? null : text(value, where);
}

function channel(value: unknown, where: string): Channel {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  exactKeys(value, ["localDid", "peerDid"], where);
  const localDid = text(value["localDid"], `${where}.localDid`);
  const peerDid = text(value["peerDid"], `${where}.peerDid`);
  if (localDid === peerDid) throw new InvalidFact(`${where} pairs a DID with itself`);
  return { localDid, peerDid };
}

function change(value: unknown, where: string): Change {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  const kind = value["kind"];
  if (kind === "rotate") {
    exactKeys(value, ["kind", "successor"], where);
    return { kind, successor: text(value["successor"], `${where}.successor`) };
  }
  if (kind === "end") {
    exactKeys(value, ["kind"], where);
    return { kind };
  }
  throw new InvalidFact(`${where}.kind is rotate or end`);
}

/** The endpoint a change of this fact replaces: the peer's for a transition, ours for a decision. */
export function replacedSide(fact: PeerTransition | LocalDecision): "local" | "peer" {
  return fact.kind === "peer-transition" ? "peer" : "local";
}

/** The pair a rotation leads to, null for an ending. */
export function successorChannel(fact: PeerTransition | LocalDecision): Channel | null {
  if (fact.change.kind === "end") return null;
  return fact.kind === "peer-transition" ? { localDid: fact.at.localDid, peerDid: fact.change.successor } : { localDid: fact.change.successor, peerDid: fact.at.peerDid };
}

function checkSuccessor(fact: PeerTransition | LocalDecision, where: string): void {
  if (fact.change.kind === "end") return;
  const replaced = replacedSide(fact) === "peer" ? fact.at.peerDid : fact.at.localDid;
  if (fact.change.successor === replaced) throw new InvalidFact(`${where}: the successor is the DID it replaces`);
  const kept = replacedSide(fact) === "peer" ? fact.at.localDid : fact.at.peerDid;
  if (fact.change.successor === kept) throw new InvalidFact(`${where}: the successor is the other endpoint of the pair`);
}

/** `value` as a fact of the profile, read once, or `InvalidFact`. */
export function validateFact(value: unknown, where = "fact"): ContinuityFact {
  if (!isPlainObject(value)) throw new InvalidFact(`${where} is an object`);
  const kind = value["kind"];
  if (kind !== "peer-transition" && kind !== "local-decision" && kind !== "address-observed") throw new InvalidFact(`${where}.kind is peer-transition, local-decision or address-observed`);
  exactKeys(value, FACT_KEYS[kind], where);
  const id = text(value["id"], `${where}.id`);
  const at = channel(value["at"], `${where}.at`);
  switch (kind) {
    case "peer-transition": {
      const fact: PeerTransition = { kind, id, at, change: change(value["change"], `${where}.change`), receipt: text(value["receipt"], `${where}.receipt`) };
      checkSuccessor(fact, where);
      return fact;
    }
    case "local-decision": {
      const fact: LocalDecision = {
        kind,
        id,
        at,
        change: change(value["change"], `${where}.change`),
        source: textOrNull(value["source"], `${where}.source`),
        decision: text(value["decision"], `${where}.decision`),
      };
      checkSuccessor(fact, where);
      if (fact.source === fact.id) throw new InvalidFact(`${where}: a decision is not its own source`);
      return fact;
    }
    case "address-observed": {
      const fact: AddressObservation = { kind, id, at, carriedTransition: textOrNull(value["carriedTransition"], `${where}.carriedTransition`), receipt: text(value["receipt"], `${where}.receipt`) };
      if (fact.carriedTransition === fact.id) throw new InvalidFact(`${where}: an observation does not carry itself`);
      return fact;
    }
  }
}

/** The RFC 8785 text of a validated fact: its identity for equality. */
export function canonicalFact(fact: ContinuityFact): string {
  return serialize(fact) as string;
}

/**
 * Code point order, which is the order of the strings' UTF-8 bytes;
 * the `<` operator would order by UTF-16 code units, which disagrees
 * for supplementary characters.
 */
export function compareUtf8(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

export function compareChannels(a: Channel, b: Channel): number {
  return compareUtf8(a.localDid, b.localDid) || compareUtf8(a.peerDid, b.peerDid);
}

export function sameChannel(a: Channel, b: Channel): boolean {
  return a.localDid === b.localDid && a.peerDid === b.peerDid;
}

/** A map key for the pair; a DID has no U+0000. */
export function channelKey(channel: Channel): string {
  return `${channel.localDid}\u0000${channel.peerDid}`;
}

export function channelOf(localDid: Did, peerDid: Did): Channel {
  return { localDid, peerDid };
}

/** A map key for the change, so that two facts declaring the same change compare equal. */
export function changeKey(change: Change): string {
  return change.kind === "end" ? "end" : `rotate\u0000${change.successor}`;
}

export function sortedIds(ids: Iterable<FactId>): FactId[] {
  return [...new Set(ids)].sort(compareUtf8);
}

export function sortedChannels(channels: Iterable<Channel>): Channel[] {
  const byKey = new Map<string, Channel>();
  for (const channel of channels) byKey.set(channelKey(channel), channel);
  return [...byKey.values()].sort(compareChannels);
}
