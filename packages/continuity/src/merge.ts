/**
 * The merge contract: a snapshot is a map from fact ID to the set of
 * distinct canonical values seen under it, and merging is union by ID.
 * Commutative, associative and idempotent; nothing selects a value,
 * nothing is deleted, and an incompatible input is refused whole.
 */

import { IncompatibleSnapshot } from "./errors.js";
import { canonicalFact, compareUtf8, validateFact } from "./facts.js";
import { PROFILE_VERSION, type ContinuityFact, type FactId, type FactSnapshot } from "./types.js";

type Bucket = Map<string, ContinuityFact>;

function checkProfile(snapshot: FactSnapshot, side: string): void {
  if (typeof snapshot.identityNamespace !== "string" || snapshot.identityNamespace.length === 0) throw new IncompatibleSnapshot(`${side}: identityNamespace is a non-empty string`);
  if (snapshot.profileVersion !== PROFILE_VERSION) throw new IncompatibleSnapshot(`${side}: profile ${JSON.stringify(snapshot.profileVersion)} is not ${PROFILE_VERSION}; convert it explicitly before merging`);
  if (!Array.isArray(snapshot.facts)) throw new IncompatibleSnapshot(`${side}: facts is an array`);
}

/** Every fact of a snapshot validated, bucketed by ID and keyed by canonical text. */
export function bucketsOf(facts: readonly unknown[], where = "facts"): Map<FactId, Bucket> {
  const buckets = new Map<FactId, Bucket>();
  facts.forEach((value, index) => {
    const fact = validateFact(value, `${where}[${index}]`);
    let bucket = buckets.get(fact.id);
    if (bucket === undefined) buckets.set(fact.id, (bucket = new Map()));
    const canonical = canonicalFact(fact);
    if (!bucket.has(canonical)) bucket.set(canonical, fact);
  });
  return buckets;
}

/** The facts of the buckets in reproducible order: by ID, then by canonical text, both in UTF-8 byte order. */
export function enumerate(buckets: ReadonlyMap<FactId, Bucket>): ContinuityFact[] {
  const ids = [...buckets.keys()].sort(compareUtf8);
  const facts: ContinuityFact[] = [];
  for (const id of ids) {
    const bucket = buckets.get(id)!;
    for (const canonical of [...bucket.keys()].sort(compareUtf8)) facts.push(bucket.get(canonical)!);
  }
  return facts;
}

/**
 * The union of two compatible snapshots as a new snapshot. Throws
 * `IncompatibleSnapshot` or `InvalidFact` before producing anything;
 * neither input is touched.
 */
export function mergeFacts(left: FactSnapshot, right: FactSnapshot): FactSnapshot {
  checkProfile(left, "left");
  checkProfile(right, "right");
  if (left.identityNamespace !== right.identityNamespace) throw new IncompatibleSnapshot(`the snapshots are of different identities: ${JSON.stringify(left.identityNamespace)} and ${JSON.stringify(right.identityNamespace)}`);
  const buckets = bucketsOf(left.facts, "left.facts");
  for (const [id, bucket] of bucketsOf(right.facts, "right.facts")) {
    const existing = buckets.get(id);
    if (existing === undefined) buckets.set(id, bucket);
    else for (const [canonical, fact] of bucket) if (!existing.has(canonical)) existing.set(canonical, fact);
  }
  return { identityNamespace: left.identityNamespace, profileVersion: PROFILE_VERSION, facts: enumerate(buckets) };
}

/** A snapshot with no facts, the identity of merge for its namespace. */
export function emptySnapshot(identityNamespace: string): FactSnapshot {
  return { identityNamespace, profileVersion: PROFILE_VERSION, facts: [] };
}

/** The snapshot with its facts validated, deduplicated and enumerated in canonical order: what merging it with the empty snapshot gives. */
export function normalizeSnapshot(snapshot: FactSnapshot): FactSnapshot {
  return mergeFacts(snapshot, emptySnapshot(snapshot.identityNamespace));
}

/** Do two compatible snapshots retain the same values? Order and repetition do not count. */
export function sameFacts(left: FactSnapshot, right: FactSnapshot): boolean {
  const a = normalizeSnapshot(left);
  const b = normalizeSnapshot(right);
  if (a.identityNamespace !== b.identityNamespace || a.facts.length !== b.facts.length) return false;
  return a.facts.every((fact, index) => canonicalFact(fact) === canonicalFact(b.facts[index]!));
}
