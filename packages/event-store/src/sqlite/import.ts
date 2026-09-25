/**
 * A portable snapshot of the same vault imported into a runtime that
 * is open: the union of the two event sets, and the objects that
 * union holds, published in one transaction or not at all. Everything
 * the source alone decides is checked before the target's lock is
 * taken; everything that depends on the target — what is new, what
 * is a fork, which roots the union holds and which of them must have
 * bytes — is decided under it, and nothing is written until all of
 * it has passed. Any runtime is a target, the vault in memory too,
 * since the import works through the interfaces every runtime
 * presents.
 */

import { AnchorMismatch, DamagedHistory, DamagedObject, ForkedAuthor, IncompleteImport, InvalidSnapshot, ReadOnlyVault } from "../errors.js";
import type { Cid, Event, EventCid } from "../event.js";
import { rawCidOf, sortCids } from "../objects.js";
import { MemoryVault, heldRootsOf, type Held, type Retained, type RetainedRoots, type Vault, type VaultObjects, type VaultRuntime } from "../vault.js";
import type { PortableDatabase } from "./open.js";
import { validatePortable } from "./portable.js";

export interface ImportOptions {
  /** The retention the events of a vault hold, folded by the caller: run on the snapshot for its validation, on the target before the import and on the prospective union, each through the vault it is handed. */
  retainedRoots: RetainedRoots;
}

export interface Imported {
  /** source events the target did not hold, now accepted */
  added: number;
  /** source events the target already held: the same CID, the same canonical bytes */
  duplicates: number;
  /** objects the union holds that the target lacked, now held from the source's verified bytes */
  objects: number;
  /** objects the union holds that the target knew damaged, replaced whole from the source's verified bytes */
  repaired: number;
}

/**
 * Imports `source`, a portable snapshot open read-only, into
 * `target`. Outside the lock: an inspector is refused (`ReadOnlyVault`)
 * before a byte of the source is read; the snapshot is validated in
 * full, its anchor compared with the target's (`AnchorMismatch` for
 * another vault's), and its events and object listing read into
 * memory. Under the lock: a damaged target history refuses the import
 * (`DamagedHistory`); each source event is classified against what
 * the target holds — a duplicate or new, by CID — and a new event
 * under the target's own author is a fork that refuses the whole
 * import with nothing written
 * (`ForkedAuthor`); the caller's fold is run on the target as it is
 * and on the prospective union; every root a new event retains in the
 * union, and every root the union holds that the target did not, must
 * have verified bytes in the source or sound accepted bytes in the
 * target, else `IncompleteImport` names each and nothing is written;
 * and every union-held object the target lacks or knows damaged,
 * whose bytes the source has, is staged — verified as it streams, the
 * source's bytes awaited under the lock but outside any transaction —
 * even when no event is new. A union-held root outside those
 * requirements that the source lacks is left as it is, absent or
 * damaged. Then one transaction publishes the staged objects and
 * repairs with every new event and its position. A target object
 * reused is not rehashed, but it is checked once more in that
 * transaction: a read outside the lock may have found it damaged
 * while the source streamed, and the import then plans again with
 * that damage known — staging the repair when the source has the
 * bytes, refusing as `IncompleteImport` when the root is required and
 * it does not — rather than accept an event over bytes known
 * damaged. The target's identity, wrapper and local state stay.
 * Importing the same snapshot again adds nothing and, when nothing is
 * to be repaired, writes nothing.
 */
export async function importVault(target: VaultRuntime, source: PortableDatabase, options: ImportOptions): Promise<Imported> {
  if (typeof options.retainedRoots !== "function") throw new TypeError("an import takes `retainedRoots`, the caller's fold of the retention edge by edge");
  if (!target.writable) throw new ReadOnlyVault("import");
  await validatePortable(source, { heldRoots: heldRootsOf(options.retainedRoots) });
  if (source.metadata.anchor !== target.metadata.anchor) throw new AnchorMismatch(target.metadata.anchor, source.metadata.anchor, "source");
  const incoming: Event[] = [];
  for await (const event of source.vault.events.scan()) incoming.push(event);
  const offered = new Set<Cid>();
  for await (const cid of source.vault.objects.list()) offered.add(cid);
  return target.locked(async (held) => {
    const [damage] = await held.events.damaged();
    if (damage !== undefined) throw new DamagedHistory(damage);
    for (;;) {
      const plan = await planned(target, held, incoming, offered, source.vault.objects, options.retainedRoots);
      const objects = plan.staged.filter((object) => !object.repair).length;
      const repaired = plan.staged.length - objects;
      if (plan.fresh.length === 0 && plan.staged.length === 0) return { added: 0, duplicates: plan.duplicates, objects, repaired };
      let sourceRead = false;
      try {
        const outcome = await held.ingest(incoming, async (prepared) => {
          for (const { cid } of plan.staged) {
            const stream = await source.vault.objects.open(cid);
            if (stream === null) throw new InvalidSnapshot([{ where: `objects/${cid}`, error: "gone between the snapshot's listing and its reading" }]);
            await prepared.putObject(cid, stream);
          }
          sourceRead = true;
          for (const cid of plan.reused) prepared.reuse(cid);
        });
        return { added: outcome.added, duplicates: outcome.duplicates, objects, repaired };
      } catch (err) {
        // With the source read, `DamagedObject` is the publication refusing a reused object a read found damaged meanwhile: the transaction rolled back and the staging dropped, the import plans again.
        if (!sourceRead || !(err instanceof DamagedObject)) throw err;
        if (!offered.has(err.cid as Cid)) throw new IncompleteImport([{ where: `objects/${err.cid}`, error: NOT_IN_SOURCE }]);
      }
    }
  });
}

const NOT_IN_SOURCE = "required by the union, known damaged in the target and not in the source";

interface ImportPlan {
  fresh: Event[];
  duplicates: number;
  staged: { cid: Cid; repair: boolean }[];
  /** the union-held objects the target holds sound and the import relies on as they are: those the source could replace, and those the union requires */
  reused: Cid[];
}

async function planned(target: VaultRuntime, held: Held, incoming: Event[], offered: Set<Cid>, sourceObjects: VaultObjects, retainedRoots: RetainedRoots): Promise<ImportPlan> {
  const before: Event[] = [];
  const have = new Set<EventCid>();
  for await (const event of held.events.scan()) {
    before.push(event);
    have.add(event.cid);
  }
  const plan: ImportPlan = { fresh: [], duplicates: 0, staged: [], reused: [] };
  const forked: Event[] = [];
  for (const event of incoming) {
    if (have.has(event.cid)) {
      plan.duplicates += 1;
      continue;
    }
    if (event.author === target.author) {
      forked.push(event);
      continue;
    }
    plan.fresh.push(event);
  }
  if (forked.length > 0) throw new ForkedAuthor(target.author, forked);
  // Both folds before any byte is checked: what the union holds decides what must have bytes, and what the target held decides which of those are newly held.
  const heldBefore = rootsOf(await checkedRetention(retainedRoots, held));
  const union = new MemoryVault({ metadata: target.metadata });
  await union.ingest([...before, ...plan.fresh]);
  const unionRetains = await unionRetention(retainedRoots, union.vault, held, offered, sourceObjects);
  const heldAfter = rootsOf(unionRetains);
  const fresh = new Set(plan.fresh.map((event) => event.cid));
  const required = new Set<Cid>();
  for (const { cid, root } of unionRetains) if (fresh.has(cid)) required.add(root);
  for (const root of heldAfter) if (!heldBefore.has(root)) required.add(root);
  const problems: { where: string; error: string }[] = [];
  for (const cid of sortCids(heldAfter)) {
    const state = await stateOf(held, cid);
    if (state === "sound") {
      if (offered.has(cid) || required.has(cid)) plan.reused.push(cid);
    } else if (offered.has(cid)) plan.staged.push({ cid, repair: state === "damaged" });
    else if (required.has(cid)) {
      problems.push({ where: `objects/${cid}`, error: state === "absent" ? "required by the union, but in neither the target nor the source" : NOT_IN_SOURCE });
    }
  }
  if (problems.length > 0) throw new IncompleteImport(problems);
  return plan;
}

/**
 * The objects the union's fold reads: what the target would hold once
 * the import is published, a sound target object as it is and
 * otherwise the source's verified bytes. A retention that depends on
 * what an object says — a release that waits for a document to verify
 * — then folds over the union as it will fold over the target
 * afterwards; over the events alone it would retain what the target
 * has released and collected, and require bytes nobody has. `streamed`
 * takes each CID answered with a stream of the target's, the one
 * answer that is verified only after it is given.
 */
function prospectiveObjects(target: VaultObjects, source: VaultObjects, streamed: Set<Cid>): VaultObjects {
  const either = async <T>(read: (objects: VaultObjects) => Promise<T | null>): Promise<T | null> => {
    try {
      const sound = await read(target);
      if (sound !== null) return sound;
    } catch (err) {
      if (!(err instanceof DamagedObject)) throw err;
      const verified = await read(source);
      if (verified === null) throw err;
      return verified;
    }
    return read(source);
  };
  return {
    open: (cid) =>
      either(async (objects) => {
        const stream = await objects.open(cid);
        if (stream !== null && objects === target) streamed.add(cid);
        return stream;
      }),
    read: (cid, maxBytes) => either((objects) => objects.read(cid, maxBytes)),
    stat: (cid) => either((objects) => objects.stat(cid)),
    has: async (cid) => (await either(async (objects) => ((await objects.has(cid)) ? true : null))) ?? false,
    async *list() {
      const cids = new Set<Cid>();
      for await (const cid of source.list()) cids.add(cid);
      for await (const cid of target.list()) cids.add(cid);
      yield* sortCids(cids);
    },
  };
}

/**
 * The caller's fold over the prospective union. A stream of the
 * target's is verified as it is consumed, so damage nobody knew of
 * shows after `open` has answered, too late for the source's bytes to
 * stand in: a fold that met it, whether it threw or took the object
 * for unreadable, is dropped and run again from the start, where the
 * damage is known and the source answers instead. Each further run is
 * owed to an object found damaged since the last that the source has,
 * and no object is owed two; a fold that fails for any other reason
 * fails the import as it did.
 */
async function unionRetention(retainedRoots: RetainedRoots, union: Vault, held: Held, offered: Set<Cid>, sourceObjects: VaultObjects): Promise<Retained[]> {
  const answered = new Set<Cid>();
  for (;;) {
    const streamed = new Set<Cid>();
    const folded = await checkedRetention(retainedRoots, { ...union, objects: prospectiveObjects(held.objects, sourceObjects, streamed) }).then(
      (retained) => ({ retained }),
      (failure: unknown) => ({ failure })
    );
    let again = false;
    for (const cid of streamed) {
      if (answered.has(cid) || !offered.has(cid) || (await stateOf(held, cid)) !== "damaged") continue;
      answered.add(cid);
      again = true;
    }
    if (again) continue;
    if ("failure" in folded) throw folded.failure;
    return folded.retained;
  }
}

async function checkedRetention(retainedRoots: RetainedRoots, vault: Vault): Promise<Retained[]> {
  const out: Retained[] = [];
  for (const { cid, root } of await retainedRoots(vault)) out.push({ cid, root: rawCidOf(root).text as Cid });
  return out;
}

function rootsOf(retained: Retained[]): Set<Cid> {
  return new Set(retained.map(({ root }) => root));
}

/** What the target holds under `cid`: sound accepted bytes as far as the target knows — nothing is rehashed — or nothing, or bytes it knows damaged. */
async function stateOf(held: Held, cid: Cid): Promise<"sound" | "absent" | "damaged"> {
  try {
    return (await held.objects.stat(cid)) === null ? "absent" : "sound";
  } catch (err) {
    if (err instanceof DamagedObject) return "damaged";
    throw err;
  }
}
