/**
 * Import into an existing folder vault: a portable folder of the same
 * vault — the same anchor — merged into one already open for writing,
 * under the writer lock from the first look at the target to the
 * publication of the merged view, through the barrier under `import/`
 * that `folder/import.ts` keeps.
 *
 * Everything is decided before anything is written. The source is read
 * and validated as a restore would read it, its anchor compared with
 * the target's; the target's event set is required whole — no damage,
 * no conflict — and read; every source event is classified against it:
 * held with the same canonical bytes, a duplicate; held with other
 * bytes, a conflict, the target's kept and the source's reported; not
 * held, new — unless its author is this replica's, which is a fork, and
 * refuses the whole import with nothing written. The fold handed in
 * computes the held roots of the merged set, and each must have bytes
 * in the target already or among the source's objects: those are the
 * objects copied, no other — a source object nothing in the merged set
 * holds is left where it is, so that bytes for a root the merged set
 * has released do not come back as an orphan. Each opaque portable path
 * of the source is copied when the target has nothing at it, and left
 * when it has; one that would land on a file or under a file of the
 * target, or where the target has a directory, refuses the import. The
 * target's `config.json` and `keystore.json` are never touched.
 *
 * Then the new events are rendered afresh, one segment per author, and
 * staged with the objects and files; the objects are verified as they
 * stream; and the whole is published through the barrier, objects
 * before the segments that name them. A failure before the journal is
 * written rolls the staging back; one after it leaves the import the
 * folder's to finish, and closes this runtime, since what it would go
 * on reading might be the union half published: the next writable open
 * finishes the import before it opens anything. Importing the same
 * source again adds nothing and writes nothing.
 */

import { v7 } from "uuid";

import type { VaultBackend } from "../backend/types.js";
import { AnchorMismatch, DamagedLayout, ForkedAuthor, IncompleteImport } from "./errors.js";
import type { AuthorId, Cid, Conflict, Damaged, Event, EventId } from "./event.js";
import { ancestorsOf, comparePaths } from "./files.js";
import { canonicalText } from "./jcs.js";
import type { Held, KeepUnderLock } from "./vault.js";
import { Staging } from "./folder/import.js";
import { ESTOC_DIR, OBJECTS_DIR, objectPath, segmentPath } from "./folder/layout.js";
import { encodeLines } from "./folder/lines.js";
import type { FolderVault } from "./folder/vault.js";
import { copy, opened, readSource, rootsOf, verifying, type Source } from "./interchange.js";

export interface ImportOptions {
  /**
   * The exact held roots of the merged event set, which the fold
   * computes over that set held as a vault in memory, under the
   * target's writer lock: every one must have bytes in the target or
   * among the source's objects, or nothing is written. The same
   * function `collect`, `exportVault` and `restoreFolder` take.
   */
  heldRoots: KeepUnderLock;
  /** the layout's directory in `from`; `.estoc` when left out */
  fromBase?: string;
}

/** What an import did, counted. */
export interface Imported {
  /** events added: the source's that the target did not hold */
  events: number;
  /** source events the target already held with the same canonical bytes */
  duplicates: number;
  /** source events under an eventId the target holds with other canonical bytes: the target's kept, nothing added */
  conflicts: Conflict[];
  /** objects copied: held roots of the merged event set the target did not hold */
  objects: number;
  /** opaque portable files copied: the source's at paths the target had nothing at */
  files: number;
}

/**
 * The portable folder under `fromBase` in `from` merged into `target`,
 * as the module comment says. Throws `NotAVault`, `PendingImport` or
 * `InvalidSnapshot` for a source that is not a valid snapshot,
 * `AnchorMismatch` for another vault's, `ForkedAuthor` for one holding
 * this replica's author over events this replica did not write,
 * `IncompleteImport` when the merged view cannot be made complete, and
 * the backend's own error when a write fails — the target then either
 * as it was, or closed with the import the next writable open's to
 * finish.
 */
export async function importFolder(target: FolderVault, from: VaultBackend, options: ImportOptions): Promise<Imported> {
  const fromBase = options.fromBase ?? ESTOC_DIR;
  return target.locked(async (held) => {
    const source = await readSource(from, fromBase);
    const anchor = target.config.identity.anchor.did;
    if (source.config.identity.anchor.did !== anchor) throw new AnchorMismatch(anchor, source.config.identity.anchor.did, "source");
    const plan = await planned(target, held, source, options.heldRoots);
    const counts: Imported = { events: 0, duplicates: plan.duplicates, conflicts: plan.conflicts, objects: plan.objects.length, files: plan.files.length };
    for (const events of plan.segments.values()) counts.events += events.length;
    if (counts.events === 0 && counts.objects === 0 && counts.files === 0) return counts;
    const staging = new Staging(target.backend, target.base);
    try {
      for (const cid of plan.objects) {
        const rel = objectPath(cid);
        await copy(staging, rel, await opened(from, `${fromBase}/${rel}`, rel), (chunks) => verifying(cid, rel, chunks, (problem) => new IncompleteImport([problem])));
      }
      for (const [author, events] of plan.segments) await staging.write(segmentPath(author, v7()), encodeLines(events));
      for (const rel of plan.files) await copy(staging, rel, await opened(from, `${fromBase}/${rel}`, rel));
      await staging.publish();
    } catch (err) {
      if (staging.published) {
        // The journal stands and the union may be half published: this
        // runtime reads no more of the folder. The close queues behind
        // this operation's lock and runs once it has thrown.
        void target.close().catch(() => undefined);
      } else {
        // Staging that cannot be removed now is removed by the next writable open.
        await staging.rollback().catch(() => undefined);
      }
      throw err;
    }
    return counts;
  });
}

/** What an import will write, decided under the lock before a byte is. */
interface Plan {
  /** the new events by author, in author order, each author's in the order the source held them */
  segments: Map<AuthorId, Event[]>;
  /** the objects to copy from the source, in binary-CID order */
  objects: Cid[];
  /** the opaque portable paths to copy from the source, in path order */
  files: string[];
  duplicates: number;
  conflicts: Conflict[];
}

async function planned(target: FolderVault, held: Held, source: Source, heldRoots: KeepUnderLock): Promise<Plan> {
  const problems: Damaged[] = [
    ...(await held.events.damaged()).map(({ where, error }) => ({ where, error })),
    ...(await held.events.conflicting()).map((conflict) => ({ where: `events:${conflict.eventId}`, error: "the same eventId with different canonical bytes" })),
  ];
  if (problems.length > 0) throw new IncompleteImport(problems);
  const have = new Map<EventId, { event: Event; text: string }>();
  for await (const event of held.events.scan()) have.set(event.eventId, { event, text: canonicalText(event) });
  const plan: Plan = { segments: new Map(), objects: [], files: [], duplicates: 0, conflicts: [] };
  const forked: Event[] = [];
  const union: Event[] = [...have.values()].map(({ event }) => event);
  for (const event of source.events) {
    const held = have.get(event.eventId);
    const own = event.author === target.author;
    if (held !== undefined) {
      if (held.text === source.texts.get(event.eventId)) {
        plan.duplicates += 1;
        continue;
      }
      plan.conflicts.push({ eventId: event.eventId, kept: held.event, rejected: event });
      if (own) forked.push(event);
      continue;
    }
    if (own) {
      forked.push(event);
      continue;
    }
    union.push(event);
    const mine = plan.segments.get(event.author);
    if (mine === undefined) plan.segments.set(event.author, [event]);
    else mine.push(event);
  }
  if (forked.length > 0) throw new ForkedAuthor(target.author, forked);
  plan.segments = new Map([...plan.segments].sort(([a], [b]) => comparePaths(a, b)));
  const offered = new Set(source.objects);
  for (const root of await rootsOf(union, heldRoots)) {
    if (await held.objects.has(root)) continue;
    if (offered.has(root)) plan.objects.push(root);
    else problems.push({ where: objectPath(root), error: "a held root of the merged event set has bytes in neither the source nor the target" });
  }
  const { backend, base } = target;
  for (const rel of source.opaque) {
    const at = `${base}/${rel}`;
    const under = (await backend.list(at)).length > 0 || (await backend.dirs(at)).length > 0;
    if (under) {
      problems.push({ where: rel, error: "a directory of the target stands where the file would" });
      continue;
    }
    const over = [];
    for (const ancestor of ancestorsOf(rel)) if ((await backend.size(`${base}/${ancestor}`)) !== null) over.push(ancestor);
    if (over.length > 0) {
      problems.push({ where: rel, error: `${over[0]} is a file of the target: nothing can stand under it` });
      continue;
    }
    if ((await backend.size(at)) === null) plan.files.push(rel);
  }
  if (problems.length > 0) throw new IncompleteImport(problems);
  if (plan.objects.length > 0 && (await backend.size(`${base}/${OBJECTS_DIR}`)) !== null) throw new DamagedLayout(OBJECTS_DIR, "a file where the objects directory belongs");
  return plan;
}
