/**
 * Restore and import on whatever the platform's driver is, as cases
 * free of any test framework: run over `node:sqlite` by
 * `import.test.ts` and over the wasm pool in a Chromium Worker by
 * `browser-driver.test.ts`. What the two platforms' SQLite must agree
 * on: a restore laying a runtime from a snapshot's values under a
 * fresh identity, and its refusals before and after the destination
 * is made; an import's union, what it reports, what it keeps of the
 * target and what a repeat of it writes; a fork; the roots the union
 * requires bytes for, in both directions; what an import fills and
 * repairs, and what it leaves; the source checked before the lock;
 * and an import interrupted at every statement of its transaction.
 */

import {
  Connection,
  MemoryVault,
  SqliteError,
  SqliteVault,
  canonicalEventBytes,
  createRuntime,
  exportVault,
  importVault,
  openInspector,
  openRuntime,
  restoreVault,
  type AuthorId,
  type Cid,
  type Draft,
  type Event,
  type HeldRoots,
  type Imported,
  type PortableDatabase,
  type RawConnection,
  type RestoreOptions,
  type SqliteDriver,
  type VaultRuntime,
} from "../../../src/v3/index.js";
import { ANCHOR, META, REWRAPPED, WRAPPED } from "../fixtures.js";
import { assert, assertBytes, assertEqual, assertRejects, rawOver } from "./driver-cases.js";
import { altered, corruptChunk, destination, opened, settled, type ExportHarness } from "./export-cases.js";
import { HELLO, HELLO_CID, MIB, all, bytesOf, cidOf, clock, draft, exec, make, reopen, rootsOf, rows, type Made } from "./vault-cases.js";

export interface ImportHarness extends ExportHarness {
  /** Puts `bytes`, a complete database file, at `target`. */
  importFile(target: string, bytes: Uint8Array): Promise<void>;
}

export interface ImportCase {
  name: string;
  run(harness: ImportHarness): Promise<string | void>;
}

const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);
const BIG = bytesOf(2 * MIB + 7, 11);
const BIG_CID = cidOf(BIG);
const OTHER_ANCHOR = "did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2";

const ids = (events: Event[]): string[] => events.map((e) => e.eventId).sort();

/** Exports `vault` to a fresh target and opens the snapshot read-only. */
async function snapshotOf(h: ImportHarness, vault: VaultRuntime, heldRoots: HeldRoots = rootsOf): Promise<{ target: string; snapshot: PortableDatabase }> {
  const target = h.fresh();
  await exportVault(vault, destination(h, target), { heldRoots });
  return { target, snapshot: await opened(h, target) };
}

/** A vault holding hello and the big object under two events, exported; the vault closed. */
async function seededSnapshot(h: ImportHarness, now: () => number): Promise<{ target: string; events: Event[]; author: AuthorId }> {
  const { vault } = await make(h, h.fresh(), now);
  const events = await vault.vault.commit(
    [
      { cid: HELLO_CID, source: HELLO },
      { cid: BIG_CID, source: BIG },
    ],
    [draft([HELLO_CID], { i: 0 }), draft([BIG_CID], { i: 1 })]
  );
  const target = h.fresh();
  await exportVault(vault, destination(h, target), { heldRoots: rootsOf });
  const { author } = vault;
  await vault.close();
  return { target, events, author };
}

const tables = (driver: SqliteDriver): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const table of ["events", "event_positions", "objects", "object_chunks"]) out[table] = rows(driver, `SELECT count(*) AS n FROM ${table}`)[0]?.["n"] as number;
  return out;
};

/** Whether `sql` writes: what a repeated import must issue none of. */
const writes = (sql: string): boolean => /^\s*(INSERT|UPDATE|DELETE|CREATE|BEGIN)/i.test(sql);

const message = (subject: string, intent: string, roots: Cid[]): Draft => ({ type: "message", roots, data: { subject, intent } });
const pack = (subject: string, roots: Cid[]): Draft => ({ type: "package", roots, data: { subject } });
const release = (of: Event): Draft => ({ type: "release", roots: [], data: { of: of.eventId } });

/**
 * A fold with a rule an import can cross: every root of every event
 * is held, except that a `release` event releases the roots of the
 * `package` it names — unless the package's subject is contested, two
 * `message` events with different intents for it, in which case the
 * package retains its roots after all.
 */
const contestable: HeldRoots = async (vault) => {
  const events = await all(vault.events.scan());
  const intents = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.type !== "message") continue;
    const subject = String(event.data["subject"]);
    intents.set(subject, (intents.get(subject) ?? new Set()).add(String(event.data["intent"])));
  }
  const contested = new Set([...intents].filter(([, seen]) => seen.size > 1).map(([subject]) => subject));
  const released = new Set(events.filter((event) => event.type === "release").map((event) => String(event.data["of"])));
  const held: Cid[] = [];
  for (const event of events) {
    if (event.type === "package" && released.has(event.eventId) && !contested.has(String(event.data["subject"]))) continue;
    held.push(...event.roots);
  }
  return held;
};

/** `inner` as a `readwrite` connection whose `n`-th statement run fails as a bad disk would; `n` past the last run fails nothing. */
function failingAt(inner: SqliteDriver, n: number): SqliteDriver {
  const raw = rawOver(inner);
  let count = 0;
  const failing: RawConnection = {
    ...raw,
    prepare: (sql) => {
      const statement = raw.prepare(sql);
      return {
        ...statement,
        run: (params) => {
          if (++count === n) throw new SqliteError(10, "disk I/O error");
          return statement.run(params);
        },
      };
    },
  };
  return new Connection(failing, "readwrite");
}

/** The vault over the runtime `driver` holds, opened as a reopen would open it. */
async function vaultOver(driver: SqliteDriver, now: () => number): Promise<Made> {
  const db = await openRuntime(driver, { anchor: ANCHOR });
  return { vault: new SqliteVault(db, { now }), driver: db.driver };
}

export const importCases: ImportCase[] = [
  {
    name: "a restore lays a runtime from the snapshot's values under a fresh identity — every event, author and canonical byte, positions in canonical order, exactly the held objects, the wrapper adopted, nothing local — that runs, commits as the new replica and exports the same values; each restore is another replica",
    run: async (h) => {
      const c = clock();
      const { vault, driver: original } = await make(h, h.fresh(), c.now);
      const unheld = bytesOf(4096, 21);
      const unheldCid = cidOf(unheld);
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: BIG_CID, source: BIG },
          { cid: unheldCid, source: unheld },
        ],
        [draft([HELLO_CID, BIG_CID], { i: 0 }), draft([], { i: 1 }), draft([unheldCid], { i: 2, released: true })]
      );
      c.advance(1000);
      const [later] = await vault.vault.commit([], [draft([HELLO_CID], { i: 3 })]);
      await vault.local.options.set("theme", "dark");
      const heldRoots: HeldRoots = async (v) => (await rootsOf(v)).filter((cid) => cid !== unheldCid);
      const { snapshot } = await snapshotOf(h, vault, heldRoots);
      const target = h.fresh();
      const open = destination(h, target);
      let asked: unknown;
      const restored = await restoreVault(snapshot, open, {
        heldRoots,
        anchor: async (wrapped) => {
          asked = wrapped;
          return ANCHOR;
        },
      });
      assertEqual(asked, WRAPPED, "the credential is asked of the snapshot's wrapper");
      assertEqual(open.created, 1, "one destination made");
      assertEqual({ events: restored.events, objects: restored.objects, objectBytes: restored.objectBytes }, { events: 4, objects: 2, objectBytes: 5 + BIG.length }, "what the snapshot held");
      const { runtime } = restored;
      assert(runtime.author !== vault.author, "a fresh replica ID");
      assert(runtime.generation !== vault.generation, "a fresh generation");
      assertEqual(runtime.metadata, META, "the metadata");
      const copy = new SqliteVault(runtime, { now: c.now });
      const { driver } = runtime;
      try {
        const scanned = await all(copy.vault.events.scan());
        const canonical = [...events, later as Event].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.eventId < b.eventId ? -1 : 1));
        assertEqual(
          scanned.map((e) => [e.eventId, e.author]),
          canonical.map((e) => [e.eventId, e.author]),
          "every event, under its historical author"
        );
        scanned.forEach((e, i) => assertBytes(canonicalEventBytes(e), canonicalEventBytes(canonical[i] as Event), `the canonical bytes of ${e.eventId}`));
        assertEqual(
          rows(driver, "SELECT accepted_seq, event_id FROM event_positions ORDER BY accepted_seq"),
          canonical.map((e, i) => ({ accepted_seq: i + 1, event_id: e.eventId })),
          "positions in canonical order"
        );
        assertEqual(rows(driver, "SELECT replica_id, store_generation, last_seq FROM store_state"), [{ replica_id: runtime.author, store_generation: runtime.generation, last_seq: 4 }], "the control row");
        assertEqual(rows(driver, "SELECT kind, ready FROM vault_meta"), [{ kind: "runtime", ready: 1 }], "a ready runtime");
        assertEqual(await copy.keystore.read(), WRAPPED, "the wrapper adopted");
        assertEqual(await all(copy.vault.objects.list()), [HELLO_CID, BIG_CID].sort(), "exactly the held objects");
        assertBytes((await copy.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object");
        assertEqual(rows(driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 4 }], "the format's chunks");
        assertEqual(await copy.local.options.keys(), [], "nothing local came along");
        assertEqual(rows(driver, "SELECT name FROM sqlite_master WHERE name LIKE 'local_%'"), [], "no local table");
        const { token } = await copy.vault.events.changes();
        const [mine] = await copy.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { i: 4 })]);
        assertEqual(mine?.author, runtime.author, "a commit is authored as the new replica");
        assertEqual((await all((await copy.vault.events.changes(undefined, token)).events)).map((e) => e.eventId), [mine?.eventId], "the frontier continues from the restored positions");
        assertEqual(await copy.ingest([later]), { added: 0, duplicates: 1, conflicts: [], rejected: [] }, "the historical author's event ingests as a duplicate, not a fork");
        // the values round-trip: the copy exports what the snapshot held, plus its own commit
        const again = await snapshotOf(h, copy, heldRoots);
        try {
          assertEqual(ids(await all(again.snapshot.vault.events.scan())), ids([...events, later as Event, mine as Event]), "the second snapshot's events");
          assertEqual(again.snapshot.wrapped, WRAPPED, "the second snapshot's wrapper");
        } finally {
          again.snapshot.close();
        }
      } finally {
        await copy.close();
      }
      const { vault: reopened } = await reopen(h, target, c.now);
      try {
        assertEqual([reopened.author, reopened.generation], [runtime.author, runtime.generation], "the identity after a reopen");
        assertEqual((await all(reopened.vault.events.scan())).length, 5, "the events after a reopen");
        assertEqual(reopened.stopped, undefined, "the restored runtime runs");
      } finally {
        await reopened.close();
      }
      const second = await restoreVault(snapshot, destination(h, h.fresh()), { heldRoots, anchor: ANCHOR });
      assert(second.runtime.author !== runtime.author, "each restore is another replica");
      second.runtime.close();
      snapshot.close();
      assertEqual(rows(original, "SELECT count(*) AS n FROM objects"), [{ n: 3 }], "the original is untouched");
      await vault.close();
    },
  },
  {
    name: "a restore is refused before the destination is made for an invalid snapshot or a credential deriving another anchor, and after it — the destination closed and left unready, opening as nothing — when the source fails as its bytes are copied or the destination is not empty; a destination not opened to create is refused",
    run: async (h) => {
      const c = clock();
      const { target: exported } = await seededSnapshot(h, c.now);
      const refused = async (what: string, snapshot: PortableDatabase, name: string, anchor: RestoreOptions["anchor"] = ANCHOR): Promise<Error> => {
        const open = destination(h, h.fresh());
        const err = await assertRejects(() => restoreVault(snapshot, open, { heldRoots: rootsOf, anchor }), name, what);
        assertEqual(open.created, 0, `${what}: no destination made`);
        return err;
      };
      const broken = h.fresh();
      await h.importFile(broken, await h.fileBytes(exported));
      await altered(h, broken, (d) => d.exec(`DELETE FROM object_chunks WHERE cid = '${HELLO_CID}'; DELETE FROM objects WHERE cid = '${HELLO_CID}'`));
      const invalid = await opened(h, broken);
      try {
        await refused("an invalid snapshot", invalid, "InvalidSnapshot");
      } finally {
        invalid.close();
      }
      const snapshot = await opened(h, exported);
      try {
        const mismatch = await refused("another anchor", snapshot, "AnchorMismatch", OTHER_ANCHOR);
        assert(mismatch.message.includes(OTHER_ANCHOR), `the derived anchor is named: ${mismatch.message}`);
        await refused("a credential that fails to unlock", snapshot, "Error", () => Promise.reject(new Error("wrong passphrase")));
        // a source whose object stream fails once the destination is made: what a source changed under the restore looks like
        const failing: PortableDatabase = {
          ...snapshot,
          vault: {
            ...snapshot.vault,
            objects: {
              ...snapshot.vault.objects,
              open: async (cid) =>
                cid !== BIG_CID
                  ? snapshot.vault.objects.open(cid)
                  : new ReadableStream<Uint8Array>({
                      pull: (controller) => controller.error(new Error("the source went away")),
                    }),
            },
          },
        };
        const unready = h.fresh();
        const open = destination(h, unready);
        let given: SqliteDriver | undefined;
        const late = await assertRejects(
          () =>
            restoreVault(failing, async (mode) => (given = await open(mode)), { heldRoots: rootsOf, anchor: ANCHOR }),
          "InvalidSnapshot",
          "a source failing as its bytes are copied"
        );
        assertEqual((late as unknown as { problems: { where: string; error: string }[] }).problems, [{ where: `objects/${BIG_CID}`, error: "the source went away" }], "the object named");
        assertEqual(open.created, 1, "the destination was made");
        await assertRejects(async () => given?.exec("SELECT 1"), "DatabaseClosed", "the destination is closed");
        await assertRejects(async () => openRuntime(await h.open(unready, "readwrite"), { anchor: ANCHOR }), "NotAVault", "the unready destination opens as nothing");
        await assertRejects(() => restoreVault(snapshot, async () => h.open(h.fresh(), "create").then((d) => Object.assign(d, { mode: "readwrite" as const })), { heldRoots: rootsOf, anchor: ANCHOR }), "TypeError", "a destination not opened to create");
        const used = h.fresh();
        const filled = await h.open(used, "create");
        filled.exec("CREATE TABLE t (x INTEGER) STRICT");
        filled.close();
        const err = await assertRejects(() => restoreVault(snapshot, async () => new Connection(rawOver(await h.open(used, "readwrite")), "create"), { heldRoots: rootsOf, anchor: ANCHOR }), "Error", "a destination that is not empty");
        assert(/already has a schema/.test(err.message), err.message);
        const still = await h.open(used, "readwrite");
        try {
          assertEqual(rows(still, "SELECT name FROM sqlite_master"), [{ name: "t" }], "the used destination is as it was");
        } finally {
          still.close();
        }
      } finally {
        snapshot.close();
      }
    },
  },
  {
    name: "an import adds the events the target lacks and the objects the union holds that it lacks, reports duplicates and conflicts with the target's value kept, and keeps the target's identity, wrapper, positions and local state; the same snapshot again adds nothing and, with nothing to repair, writes nothing; a vault in memory is a target too",
    run: async (h) => {
      const c = clock();
      const a = await make(h, h.fresh(), c.now);
      const [e1, e2] = (await a.vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: BIG_CID, source: BIG },
        ],
        [draft([HELLO_CID], { i: 0 }), draft([BIG_CID], { i: 1 })]
      )) as [Event, Event];
      const { snapshot } = await snapshotOf(h, a.vault);
      await a.vault.close();
      const seen: string[] = [];
      const bTarget = h.fresh();
      const bDriver = new Connection(rawOver(await h.open(bTarget, "create"), { seen }), "create");
      const b = new SqliteVault(createRuntime(bDriver, { metadata: META, wrapped: WRAPPED }), { now: c.now });
      const [f1] = await b.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { from: "b" })]);
      await b.keystore.rewrap(REWRAPPED);
      await b.local.options.set("theme", "dark");
      await b.local.cache.put("thumbs", "x", HELLO);
      // b holds e1's ID with other bytes, and no root for it
      const altered = { ...e1, roots: [], data: { ...e1.data, altered: true } };
      assertEqual(await b.ingest([altered]), { added: 1, duplicates: 0, conflicts: [], rejected: [] }, "b's own value under e1's ID");
      const { token } = await b.vault.events.changes();
      const { author, generation } = b;
      const before = tables(bDriver);
      const outcome = await importVault(b, snapshot, { heldRoots: rootsOf });
      assertEqual(
        { ...outcome, conflicts: outcome.conflicts.map((conflict) => [conflict.eventId, conflict.kept.data, conflict.rejected.data]) },
        { added: 1, duplicates: 0, conflicts: [[e1.eventId, { altered: true, i: 0, n: 1 }, e1.data]], objects: 1, repaired: 0 },
        "what the import reports: the kept value in canonical form"
      );
      assertEqual([b.author, b.generation], [author, generation], "the identity stays");
      assertEqual(await b.keystore.read(), REWRAPPED, "the wrapper stays");
      assertEqual(await b.local.options.get("theme"), "dark", "the options stay");
      assertEqual(await b.local.cache.get("thumbs", "x"), undefined, "the cache is dropped with the accepted state it was built from");
      assertEqual(ids(await all(b.vault.events.scan())), ids([f1 as Event, altered as Event, e2]), "the union");
      assertEqual((await all(b.vault.events.scan({ author: e1.author }))).map((e) => e.data), [{ altered: true, i: 0, n: 1 }, e2.data], "the target's value kept under the contested ID");
      assertEqual(rows(bDriver, "SELECT accepted_seq, event_id FROM event_positions ORDER BY accepted_seq"), [{ accepted_seq: 1, event_id: f1?.eventId }, { accepted_seq: 2, event_id: e1.eventId }, { accepted_seq: 3, event_id: e2.eventId }], "the new event takes the next position");
      assertEqual((await all((await b.vault.events.changes(undefined, token)).events)).map((e) => e.eventId), [e2.eventId], "the delta since the token is the new event");
      assertEqual(await all(b.vault.objects.list()), [WORLD_CID, BIG_CID].sort(), "the big object came along; hello, held by no event of the union, did not");
      assertBytes((await b.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object's bytes");
      assertEqual((await b.vault.events.conflicting()).map((conflict) => conflict.eventId), [e1.eventId], "the conflict is on record");
      assertEqual(tables(bDriver), { events: before["events"]! + 1, event_positions: before["event_positions"]! + 1, objects: before["objects"]! + 1, object_chunks: before["object_chunks"]! + 3 }, "the rows one import adds");
      // again: nothing new; the conflict is reported again and stays one record; the cache is not dropped
      await b.local.cache.put("thumbs", "y", HELLO);
      const repeated = await importVault(b, snapshot, { heldRoots: rootsOf });
      assertEqual({ ...repeated, conflicts: repeated.conflicts.length }, { added: 0, duplicates: 1, conflicts: 1, objects: 0, repaired: 0 }, "the repeat");
      assertEqual((await b.vault.events.conflicting()).length, 1, "one record still");
      assertBytes((await b.local.cache.get("thumbs", "y")) as Uint8Array, HELLO, "the cache stays when nothing landed");
      assertEqual(tables(bDriver), { events: before["events"]! + 1, event_positions: before["event_positions"]! + 1, objects: before["objects"]! + 1, object_chunks: before["object_chunks"]! + 3 }, "no row added by the repeat");
      snapshot.close();
      // a snapshot with nothing to add and no conflict: no statement writes
      const own = await snapshotOf(h, b);
      const mark = seen.length;
      assertEqual(await importVault(b, own.snapshot, { heldRoots: rootsOf }), { added: 0, duplicates: 3, conflicts: [], objects: 0, repaired: 0 }, "the target's own snapshot");
      const written = seen.slice(mark).filter(writes);
      assertEqual(written, [], "no statement wrote");
      own.snapshot.close();
      await b.close();
      // the vault in memory as a target
      const { vault: bAgain } = await reopen(h, bTarget, c.now);
      const fromB = await snapshotOf(h, bAgain);
      await bAgain.close();
      const memory = new MemoryVault({ metadata: META, wrapped: WRAPPED, now: c.now });
      await memory.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { in: "memory" })]);
      assertEqual(await importVault(memory, fromB.snapshot, { heldRoots: rootsOf }), { added: 3, duplicates: 0, conflicts: [], objects: 2, repaired: 0 }, "the import into memory");
      assertEqual((await all(memory.vault.events.scan())).length, 4, "the union in memory");
      assertBytes((await memory.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object in memory");
      assertEqual(await importVault(memory, fromB.snapshot, { heldRoots: rootsOf }), { added: 0, duplicates: 3, conflicts: [], objects: 0, repaired: 0 }, "again, nothing");
      fromB.snapshot.close();
    },
  },
  {
    name: "a snapshot holding, under the target's own author, an event the target does not hold is a fork: refused with nothing staged and nothing written; after an identity reset the same snapshot imports, the event under its historical author",
    run: async (h) => {
      const c = clock();
      const target = h.fresh();
      const { vault } = await make(h, target, c.now);
      const [e1] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const { author } = vault;
      await vault.close();
      // a clone of the runtime file: two writable copies sharing one replica ID
      const cloneTarget = h.fresh();
      await h.importFile(cloneTarget, await h.fileBytes(target));
      const clone = await reopen(h, cloneTarget, c.now);
      assertEqual(clone.vault.author, author, "the clone writes as the same replica");
      c.advance(1000);
      const [e2] = await clone.vault.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { from: "clone" })]);
      const { snapshot } = await snapshotOf(h, clone.vault);
      await clone.vault.close();
      const { vault: again, driver } = await reopen(h, target, c.now);
      const before = tables(driver);
      const err = await assertRejects(() => importVault(again, snapshot, { heldRoots: rootsOf }), "ForkedAuthor", "the import");
      assertEqual((err as unknown as { events: Event[] }).events.map((e) => e.eventId), [e2?.eventId], "the forked event named");
      assertEqual(tables(driver), before, "nothing written");
      assertEqual(rows(driver, "SELECT count(*) AS n FROM sqlite_temp_master WHERE name = 'staging_chunks'"), [{ n: 0 }], "nothing staged: the staging table was never made");
      await again.close();
      const { vault: reset } = await reopen(h, target, c.now, true);
      try {
        assert(reset.author !== author, "a new replica ID");
        assertEqual(await importVault(reset, snapshot, { heldRoots: rootsOf }), { added: 1, duplicates: 1, conflicts: [], objects: 1, repaired: 0 }, "the import after the reset");
        assertEqual(
          (await all(reset.vault.events.scan())).map((e) => [e.eventId, e.author]),
          [
            [e1?.eventId, author],
            [e2?.eventId, author],
          ],
          "both events under the historical author"
        );
        assertBytes((await reset.vault.objects.read(WORLD_CID, 5)) as Uint8Array, WORLD, "the world came along");
      } finally {
        await reset.close();
      }
      snapshot.close();
    },
  },
  {
    name: "every root a new event retains in the union, and every root the union holds that the target did not, must have bytes in the source or sound bytes in the target: a package the target released and collected, retained again by an intent the source contests, refuses the import in both directions with nothing written; a root held before and after that no new event retains, absent or damaged with no source bytes, does not",
    run: async (h) => {
      const c = clock();
      const RM = bytesOf(64, 31);
      const RM_CID = cidOf(RM);
      const RE = bytesOf(96, 32);
      const RE_CID = cidOf(RE);
      // a: the message, its package with envelope E, and the release; E collected
      const a = await make(h, h.fresh(), c.now);
      await a.vault.vault.commit([{ cid: RM_CID, source: RM }], [message("M", "send", [RM_CID])]);
      const [p1] = await a.vault.vault.commit([{ cid: RE_CID, source: RE }], [pack("M", [RE_CID])]);
      await a.vault.vault.commit([], [release(p1 as Event)]);
      assertEqual(await a.vault.collect(contestable), { removed: [RE_CID] }, "the envelope released and collected");
      // b: another intent for the same subject
      const b = await make(h, h.fresh(), c.now);
      await b.vault.vault.commit([{ cid: RM_CID, source: RM }], [message("M", "recall", [RM_CID])]);
      const fromB = await snapshotOf(h, b.vault, contestable);
      const fromA = await snapshotOf(h, a.vault, contestable);
      assertEqual(await all(fromA.snapshot.vault.objects.list()), [RM_CID], "a's snapshot carries no envelope: released at its cut");
      const refused = async (what: string, target: Made, snapshot: PortableDatabase): Promise<void> => {
        const before = tables(target.driver);
        const events = ids(await all(target.vault.vault.events.scan()));
        const err = await assertRejects(() => importVault(target.vault, snapshot, { heldRoots: contestable }), "IncompleteImport", what);
        assertEqual((err as unknown as { problems: { where: string }[] }).problems.map((p) => p.where), [`objects/${RE_CID}`], `${what}: the envelope named`);
        assertEqual(tables(target.driver), before, `${what}: nothing written`);
        assertEqual(ids(await all(target.vault.vault.events.scan())), events, `${what}: the events as they were`);
      };
      await refused("into a: the existing package retains the envelope again", a, fromB.snapshot);
      await refused("into b: the newly accepted package retains the envelope", b, fromA.snapshot);
      fromA.snapshot.close();
      fromB.snapshot.close();
      await a.vault.close();
      await b.vault.close();
      // a root held before and after, retained by no new event: its bytes are not required
      const RX = bytesOf(48, 33);
      const RX_CID = cidOf(RX);
      const RY = bytesOf(48, 34);
      const RY_CID = cidOf(RY);
      const RZ = bytesOf(48, 35);
      const RZ_CID = cidOf(RZ);
      const d = await make(h, h.fresh(), c.now);
      await d.vault.vault.commit([{ cid: RY_CID, source: RY }], [draft([RY_CID], { from: "d" })]);
      const [pz] = await d.vault.vault.commit([{ cid: RZ_CID, source: RZ }], [pack("Z", [RZ_CID])]);
      await d.vault.vault.commit([], [release(pz as Event)]);
      assertEqual(await d.vault.collect(contestable), { removed: [RZ_CID] }, "d released its package");
      const fromD = await snapshotOf(h, d.vault, contestable);
      await d.vault.close();
      for (const state of ["damaged", "absent"] as const) {
        const target = await make(h, h.fresh(), c.now);
        await target.vault.vault.commit([{ cid: RX_CID, source: RX }], [draft([RX_CID], { from: "target" })]);
        if (state === "damaged") {
          corruptChunk(target.driver, RX_CID);
          await assertRejects(() => target.vault.vault.objects.read(RX_CID, 48), "DamagedObject", "the damage known");
        } else {
          exec(target.driver, "DELETE FROM object_chunks WHERE cid = ?", RX_CID);
          exec(target.driver, "DELETE FROM objects WHERE cid = ?", RX_CID);
        }
        assertEqual(await importVault(target.vault, fromD.snapshot, { heldRoots: contestable }), { added: 3, duplicates: 0, conflicts: [], objects: 1, repaired: 0 }, `${state}: the import goes through; the released package's root, which the union does not hold, needs no bytes`);
        assertEqual(await target.vault.vault.objects.has(RY_CID), true, `${state}: the new root came along`);
        assertEqual(await target.vault.vault.objects.has(RZ_CID), false, `${state}: the released root did not`);
        if (state === "damaged") await assertRejects(() => target.vault.vault.objects.read(RX_CID, 48), "DamagedObject", "the damage stays");
        else assertEqual(await target.vault.vault.objects.has(RX_CID), false, "the absence stays");
        await target.vault.close();
      }
      fromD.snapshot.close();
    },
  },
  {
    name: "an import fills absent union-held objects and repairs known-damaged ones from the source, dropping the cache, even when every event is a duplicate; damage forgotten by a reopen is not repaired, and is once found again; a root the target released is not revived by a snapshot that still has it",
    run: async (h) => {
      const c = clock();
      const target = h.fresh();
      const { vault, driver } = await make(h, target, c.now);
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: BIG_CID, source: BIG },
        ],
        [draft([HELLO_CID], { i: 0 }), draft([BIG_CID], { i: 1 })]
      );
      const { snapshot } = await snapshotOf(h, vault);
      const imported = async (what: string, into: SqliteVault, outcome: Partial<Imported>): Promise<void> => {
        assertEqual(await importVault(into, snapshot, { heldRoots: rootsOf }), { added: 0, duplicates: events.length, conflicts: [], objects: 0, repaired: 0, ...outcome }, what);
      };
      corruptChunk(driver, HELLO_CID);
      await assertRejects(() => vault.vault.objects.read(HELLO_CID, 5), "DamagedObject", "hello known damaged");
      exec(driver, "DELETE FROM object_chunks WHERE cid = ?", BIG_CID);
      exec(driver, "DELETE FROM objects WHERE cid = ?", BIG_CID);
      await vault.local.cache.put("thumbs", "x", HELLO);
      await imported("repaired and filled", vault, { objects: 1, repaired: 1 });
      assertBytes((await vault.vault.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "hello repaired");
      assertBytes((await vault.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object filled");
      assertEqual(await vault.local.cache.get("thumbs", "x"), undefined, "the cache dropped with the repair");
      // damage forgotten by a reopen: the object is reused, not rehashed
      corruptChunk(driver, BIG_CID, 1);
      await vault.close();
      const open = await reopen(h, target, c.now);
      await imported("nothing known damaged", open.vault, {});
      await assertRejects(() => open.vault.vault.objects.read(BIG_CID, BIG.length), "DamagedObject", "the damage found again");
      await imported("repaired once known", open.vault, { repaired: 1 });
      assertBytes((await open.vault.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object repaired");
      snapshot.close();
      // a released root is not revived
      const [pkg] = await open.vault.vault.commit([{ cid: WORLD_CID, source: WORLD }], [pack("W", [WORLD_CID])]);
      const withWorld = await snapshotOf(h, open.vault, contestable);
      await open.vault.vault.commit([], [release(pkg as Event)]);
      assertEqual(await open.vault.collect(contestable), { removed: [WORLD_CID] }, "the world released and collected");
      assertEqual(await importVault(open.vault, withWorld.snapshot, { heldRoots: contestable }), { added: 0, duplicates: 3, conflicts: [], objects: 0, repaired: 0 }, "the snapshot that still has the world adds nothing");
      assertEqual(await open.vault.vault.objects.has(WORLD_CID), false, "the world is not revived");
      withWorld.snapshot.close();
      await open.vault.close();
    },
  },
  {
    name: "the source is validated before the target's lock is taken: an invalid snapshot is refused while an operation holds the lock, a valid import waits its turn; another vault's snapshot and an inspector are refused with nothing written",
    run: async (h) => {
      const c = clock();
      const { target: exported } = await seededSnapshot(h, c.now);
      const broken = h.fresh();
      await h.importFile(broken, await h.fileBytes(exported));
      await altered(h, broken, (d) => exec(d, "UPDATE objects SET size = 6 WHERE cid = ?", HELLO_CID));
      const target = h.fresh();
      const { vault } = await make(h, target, c.now);
      let admit!: () => void;
      const gate = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const holding = vault.locked(() => gate);
      const invalid = await opened(h, broken);
      const refusal = importVault(vault, invalid, { heldRoots: rootsOf });
      assertEqual(await settled(refusal), true, "the invalid source is refused without the lock");
      await assertRejects(() => refusal, "InvalidSnapshot", "the refusal");
      invalid.close();
      const valid = await opened(h, exported);
      const importing = importVault(vault, valid, { heldRoots: rootsOf });
      assertEqual(await settled(importing), false, "the valid import waits on the lock");
      admit();
      await holding;
      assertEqual((await importing).added, 2, "and lands after");
      await vault.close();
      // another vault's snapshot
      const other = new SqliteVault(createRuntime(await h.open(h.fresh(), "create"), { metadata: { version: 3, anchor: OTHER_ANCHOR }, wrapped: WRAPPED }), { now: c.now });
      await other.vault.commit([], [draft([], { other: true })]);
      const foreign = await snapshotOf(h, other);
      await other.close();
      const { vault: again, driver } = await reopen(h, target, c.now);
      const before = tables(driver);
      const mismatch = await assertRejects(() => importVault(again, foreign.snapshot, { heldRoots: rootsOf }), "AnchorMismatch", "another vault's snapshot");
      assert(mismatch.message.includes("another vault's snapshot"), mismatch.message);
      assertEqual(tables(driver), before, "nothing written");
      await again.close();
      foreign.snapshot.close();
      // an inspector: refused before the source is read, even one with nothing to add
      const inspector = new SqliteVault(openInspector(await h.open(target, "readwrite")), { now: c.now });
      try {
        assertEqual(inspector.writable, false, "an inspector is not writable");
        await assertRejects(() => importVault(inspector, valid, { heldRoots: rootsOf }), "ReadOnlyVault", "an inspector imports nothing");
        valid.close();
        await assertRejects(() => importVault(inspector, valid, { heldRoots: rootsOf }), "ReadOnlyVault", "refused before the closed source is asked for anything");
      } finally {
        await inspector.close();
      }
    },
  },
  {
    name: "an import interrupted at any statement of its transaction leaves the target with the whole old union, and one whose COMMIT fails with the whole old or the whole new: never staging, never a part",
    run: async (h) => {
      const c = clock();
      const target = h.fresh();
      const { vault } = await make(h, target, c.now);
      const [e1] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      await vault.close();
      const pristine = await h.fileBytes(target);
      const { target: exported, events: incoming } = await seededSnapshot(h, c.now);
      const snapshot = await opened(h, exported);
      const oldUnion = { events: [e1?.eventId], objects: [HELLO_CID] };
      const newUnion = { events: ids([e1 as Event, ...incoming]), objects: [HELLO_CID, BIG_CID].sort() };
      const state = async (): Promise<{ events: (string | undefined)[]; objects: string[] }> => {
        const { vault: check } = await reopen(h, target, c.now);
        try {
          assertEqual(await check.vault.events.damaged(), [], "no damage");
          assertEqual(check.stopped, undefined, "the vault runs");
          for (const cid of await all(check.vault.objects.list())) assert((await check.vault.objects.stat(cid)) !== null, `${cid} reads`);
          return { events: (await all(check.vault.events.scan())).map((e) => e.eventId), objects: await all(check.vault.objects.list()) };
        } finally {
          await check.close();
        }
      };
      let statements = 0;
      for (let n = 1; ; n++) {
        const { vault: failing } = await vaultOver(failingAt(await h.open(target, "readwrite"), n), c.now);
        let outcome: Imported | undefined;
        try {
          outcome = await importVault(failing, snapshot, { heldRoots: rootsOf });
        } catch (err) {
          assert(err instanceof SqliteError, `statement ${n}: ${String(err)}`);
        } finally {
          await failing.close();
        }
        if (outcome !== undefined) {
          statements = n - 1;
          assertEqual(outcome, { added: 2, duplicates: 0, conflicts: [], objects: 1, repaired: 0 }, "past the last statement the import lands");
          assertEqual(await state(), newUnion, "the whole new union");
          break;
        }
        assertEqual(await state(), oldUnion, `statement ${n}: the whole old union`);
      }
      assert(statements >= 8, `the import ran ${statements} statements`);
      // a COMMIT that fails: reported unknown, and on reopen the old or the new whole
      for (const landed of [false, true]) {
        const fresh = h.fresh();
        await h.importFile(fresh, pristine);
        const { vault: uncertain } = await vaultOver(new Connection(rawOver(await h.open(fresh, "readwrite"), { failCommit: () => true, landed }), "readwrite"), c.now);
        await assertRejects(() => importVault(uncertain, snapshot, { heldRoots: rootsOf }), "UncertainCommit", `landed ${landed}: the import`);
        assertEqual(uncertain.stopped?.name, "UncertainCommit", `landed ${landed}: stopped`);
        await uncertain.close();
        const { vault: check } = await reopen(h, fresh, c.now);
        try {
          const events = ids(await all(check.vault.events.scan()));
          assertEqual(events, landed ? newUnion.events : [e1?.eventId], `landed ${landed}: the union after`);
        } finally {
          await check.close();
        }
      }
      snapshot.close();
    },
  },
];
