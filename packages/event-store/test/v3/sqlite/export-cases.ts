/**
 * Export, portable validation and inspection on whatever the
 * platform's driver is, as cases free of any test framework: run over
 * `node:sqlite` by `export.test.ts` and over the wasm pool in a
 * Chromium Worker by `browser-driver.test.ts`. What the two platforms'
 * SQLite must agree on: what a snapshot holds and what never enters
 * it, the refusals before and after the destination is made, the cut
 * held against the operations waiting on the lock, the vault in
 * memory exporting into the same file, and every way a snapshot that
 * opens can still fail validation.
 */

import {
  MemoryVault,
  exportVault,
  openPortable,
  validatePortable,
  type Cid,
  type Event,
  type HeldRoots,
  type OpenDestination,
  type PortableDatabase,
  type SqliteDriver,
  type VaultRuntime,
} from "../../../src/v3/index.js";
import { META, REWRAPPED, WRAPPED } from "../fixtures.js";
import { assert, assertBytes, assertEqual, assertRejects } from "./driver-cases.js";
import { HELLO, HELLO_CID, MIB, all, bytesOf, cidOf, clock, damageEvent, draft, exec, make, rootsOf, rows, type VaultHarness } from "./vault-cases.js";

export interface ExportHarness extends VaultHarness {
  /** The complete bytes of the file at `target`, which no connection holds open. */
  fileBytes(target: string): Promise<Uint8Array>;
}

export interface ExportCase {
  name: string;
  run(harness: ExportHarness): Promise<string | void>;
}

const EMPTY = new Uint8Array(0);
const EMPTY_CID = cidOf(EMPTY);
const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);
const BIG = bytesOf(2 * MIB + 7, 11);
const BIG_CID = cidOf(BIG);

/** Every root but `except`: what a fold that had released that object would compute. */
const rootsExcept =
  (except: Cid): HeldRoots =>
  async (vault) =>
    (await rootsOf(vault)).filter((cid) => cid !== except);

/** An opener over the harness for `target`, counting the destinations it created. */
function destination(h: ExportHarness, target: string): OpenDestination & { created: number } {
  const open = (async (mode: "create" | "readonly") => {
    if (mode === "create") open.created += 1;
    return h.open(target, mode);
  }) as OpenDestination & { created: number };
  open.created = 0;
  return open;
}

async function opened(h: ExportHarness, target: string): Promise<PortableDatabase> {
  return openPortable(await h.open(target, "readonly"));
}

/** Whether `bytes` contains `needle`. */
function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Has `p` settled by the time the runnable work has run? */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return done;
}

/** Flips one byte of chunk `chunkNo` of `cid`, as a bad sector would. */
function corruptChunk(driver: SqliteDriver, cid: Cid, chunkNo = 0): void {
  const [row] = rows(driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = ?", cid, chunkNo);
  if (row === undefined) throw new Error(`${cid} has no chunk ${chunkNo}`);
  const bytes = new Uint8Array(row["bytes"] as Uint8Array);
  bytes[0] = (bytes[0] as number) ^ 0x01;
  exec(driver, "UPDATE object_chunks SET bytes = ? WHERE cid = ? AND chunk_no = ?", bytes, cid, chunkNo);
}

const ids = (events: Event[]): string[] => events.map((e) => e.eventId).sort();

/** A vault holding hello, the big object and the empty object under three events, exported to a fresh target; the vault closed. */
async function exported(h: ExportHarness): Promise<{ target: string; events: Event[] }> {
  const c = clock();
  const { vault } = await make(h, h.fresh(), c.now);
  const events = await vault.vault.commit(
    [
      { cid: HELLO_CID, source: HELLO },
      { cid: BIG_CID, source: BIG },
      { cid: EMPTY_CID, source: EMPTY },
    ],
    [draft([HELLO_CID, BIG_CID], { i: 0 }), draft([EMPTY_CID], { i: 1 }), draft([], { i: 2 })]
  );
  const target = h.fresh();
  await exportVault(vault, destination(h, target), { heldRoots: rootsOf });
  await vault.close();
  return { target, events };
}

/** Alters the file at `target` through a writable open, as a hostile or careless hand would. */
async function altered(h: ExportHarness, target: string, body: (driver: SqliteDriver) => void): Promise<void> {
  const driver = await h.open(target, "readwrite");
  try {
    body(driver);
  } finally {
    driver.close();
  }
}

export const exportCases: ExportCase[] = [
  {
    name: "an export carries the metadata, the wrapper, every event and exactly the held objects of its cut, and nothing local; the file validates, opens as a portable snapshot and reads as a vault that refuses commit and changes; a later export leaves it untouched",
    run: async (h) => {
      const c = clock();
      const { vault, driver } = await make(h, h.fresh(), c.now);
      const unheld = bytesOf(4096, 21);
      const unheldCid = cidOf(unheld);
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: BIG_CID, source: BIG },
          { cid: EMPTY_CID, source: EMPTY },
          { cid: unheldCid, source: unheld },
        ],
        [draft([HELLO_CID, BIG_CID], { i: 0 }), draft([EMPTY_CID], { i: 1 }), draft([unheldCid], { i: 2, released: true })]
      );
      await vault.local.options.set("theme", "OPTION-SENTINEL-7f3a");
      await vault.local.cache.put("thumbs", "x", bytesOf(512, 22));
      await vault.local.trace.append("delivery", { mark: "TRACE-SENTINEL-9c1d" });
      const target = h.fresh();
      const open = destination(h, target);
      const heldRoots = rootsExcept(unheldCid);
      assertEqual(await exportVault(vault, open, { heldRoots }), { events: 3, objects: 3, bytes: 5 + BIG.length }, "what the export reports");
      assertEqual(open.created, 1, "one destination made");
      const bytes = await h.fileBytes(target);
      for (const [what, needle] of [
        ["the unheld object", unheld.subarray(0, 64)],
        ["the option", utf8("OPTION-SENTINEL-7f3a")],
        ["the cache entry", bytesOf(512, 22).subarray(0, 64)],
        ["the trace entry", utf8("TRACE-SENTINEL-9c1d")],
        ["the generation", utf8(vault.generation)],
        ["a local table", utf8("local_")],
        ["the control table", utf8("store_state")],
        ["the positions table", utf8("event_positions")],
      ] as const) {
        assert(!contains(bytes, needle), `${what} is in the file`);
      }
      assertEqual(Array.from(bytes.subarray(18, 20)), [1, 1], "rollback-format headers");
      const snapshot = await opened(h, target);
      try {
        assertEqual(snapshot.metadata, META, "the metadata");
        assertEqual(snapshot.wrapped, WRAPPED, "the wrapper");
        assertEqual(rows(snapshot.driver, "SELECT type, name FROM sqlite_master WHERE type = 'table' ORDER BY name"), ["events", "keystore", "object_chunks", "objects", "vault_meta"].map((name) => ({ type: "table", name })), "the five tables and nothing else");
        assertEqual(rows(snapshot.driver, "PRAGMA journal_mode"), [{ journal_mode: "delete" }], "a rollback journal");
        assertEqual(rows(snapshot.driver, "SELECT kind, ready FROM vault_meta"), [{ kind: "portable", ready: 1 }], "portable and ready");
        assertEqual(await validatePortable(snapshot, { heldRoots }), { events: 3, objects: 3, bytes: 5 + BIG.length }, "validated again");
        const v = snapshot.vault;
        assertEqual(v.metadata, META, "the vault's metadata");
        assertEqual(ids(await all(v.events.scan())), ids(events), "every event, the one whose root was released included");
        assertEqual((await all(v.events.scan({ type: "test.event", data: { i: 1 } }))).map((e) => e.eventId), [events[1]?.eventId], "a filtered scan");
        assertEqual(await all(v.events.scan({ type: "other" })), [], "a scan of another type");
        assertEqual(await v.events.damaged(), [], "no damage");
        assertEqual(await v.events.conflicting(), [], "no conflict travels");
        await assertRejects(() => v.events.changes(), "UnsupportedOperation", "changes");
        await assertRejects(() => v.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]), "UnsupportedOperation", "commit");
        assertEqual(await all(v.objects.list()), [HELLO_CID, BIG_CID, EMPTY_CID].sort(), "exactly the held objects");
        assertBytes((await v.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object");
        assertBytes((await v.objects.read(HELLO_CID, 5)) as Uint8Array, HELLO, "hello");
        assertBytes((await v.objects.read(EMPTY_CID, 0)) as Uint8Array, EMPTY, "the empty object");
        await assertRejects(() => v.objects.read(HELLO_CID, 4), "ObjectTooLarge", "a read over its bound");
        assertEqual(await v.objects.has(unheldCid), false, "the released object is absent");
        assertEqual(await v.objects.stat(HELLO_CID), { cid: HELLO_CID, codec: "raw", size: 5 }, "stat");
        assertEqual(rows(snapshot.driver, "SELECT count(*) AS n FROM object_chunks"), [{ n: 4 }], "three chunks of the big object and one of hello");
      } finally {
        snapshot.close();
      }
      await assertRejects(() => all(snapshot.vault.events.scan()), "VaultClosed", "a scan after close");
      await assertRejects(() => snapshot.vault.objects.has(HELLO_CID), "VaultClosed", "a presence check after close");
      assertEqual(rows(driver, "SELECT count(*) AS n FROM objects"), [{ n: 4 }], "the runtime keeps the released object until it is collected");
      // the runtime moves on; the first file does not
      await vault.keystore.rewrap(REWRAPPED);
      await vault.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { i: 3 })]);
      const second = h.fresh();
      assertEqual(await exportVault(vault, destination(h, second), { heldRoots }), { events: 4, objects: 4, bytes: 10 + BIG.length }, "the second export");
      assertBytes(await h.fileBytes(target), bytes, "the first file is as it was");
      const again = await opened(h, second);
      try {
        assertEqual(again.wrapped, REWRAPPED, "the second carries the new wrapper");
        assertEqual((await all(again.vault.events.scan())).length, 4, "and the new event");
      } finally {
        again.close();
      }
      await vault.close();
    },
  },
  {
    name: "an export is refused before the destination is made when the history has damage or a conflict, a held root is absent or known damaged, or the cut passes the byte bound; a root whose bytes fail as they are copied leaves the destination unready",
    run: async (h) => {
      const c = clock();
      const { vault, driver } = await make(h, h.fresh(), c.now);
      await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const other = await make(h, h.fresh(), c.now);
      const [foreign] = await other.vault.vault.commit([], [draft([], { from: "other" })]);
      await other.vault.close();
      const refused = async (what: string, heldRoots: HeldRoots = rootsOf, maxBytes?: number): Promise<{ where: string; error: string }[]> => {
        const target = h.fresh();
        const open = destination(h, target);
        const err = await assertRejects(() => exportVault(vault, open, maxBytes === undefined ? { heldRoots } : { heldRoots, maxBytes }), maxBytes === undefined ? "IncompleteSnapshot" : "SnapshotTooLarge", what);
        assertEqual(open.created, 0, `${what}: no destination made`);
        return (err as unknown as { problems?: { where: string; error: string }[] }).problems ?? [];
      };
      assertEqual((await refused("an absent root", async (v) => [...(await rootsOf(v)), WORLD_CID])).map((p) => p.where), [`objects/${WORLD_CID}`], "the absent root named");
      assertEqual((await refused("over the bound", rootsOf, 4)).length, 0, "the bound");
      assertEqual(await vault.ingest([foreign]), { added: 1, duplicates: 0, conflicts: [], rejected: [] }, "the foreign event");
      const conflicting = { ...(foreign as Event), data: { from: "other", altered: true } };
      assertEqual((await vault.ingest([conflicting])).conflicts.length, 1, "a conflict recorded");
      assertEqual((await refused("a conflict")).map((p) => p.where), [`events/${foreign?.eventId}`], "the conflict named");
      await vault.stores.events.clearConflicts();
      const fine = h.fresh();
      assertEqual(await exportVault(vault, destination(h, fine), { heldRoots: rootsOf }), { events: 2, objects: 1, bytes: 5 }, "exported once the conflicts are cleared");
      corruptChunk(driver, HELLO_CID);
      await assertRejects(() => vault.vault.objects.read(HELLO_CID, 5), "DamagedObject", "the damage found by a read");
      const damaged = await refused("a held root known damaged");
      assertEqual(damaged.map((p) => p.where), [`objects/${HELLO_CID}`], "the damaged root named");
      assert(/hash/.test(damaged[0]?.error ?? ""), `what was wrong: ${damaged[0]?.error}`);
      await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { repaired: true })]);
      damageEvent(driver, foreign as Event);
      assertEqual((await refused("a damaged event")).map((p) => p.where), [`events/${foreign?.eventId}`], "the damaged event named");
      await vault.close();
      // a lazy failure: the bytes are wrong but no read has found it yet
      const { vault: lazy, driver: lazyDriver } = await make(h, h.fresh(), c.now);
      await lazy.vault.commit([{ cid: BIG_CID, source: BIG }], [draft([BIG_CID])]);
      corruptChunk(lazyDriver, BIG_CID, 1);
      const target = h.fresh();
      const open = destination(h, target);
      const late = await assertRejects(() => exportVault(lazy, open, { heldRoots: rootsOf }), "IncompleteSnapshot", "a root whose bytes fail as they are copied");
      assertEqual((late as unknown as { problems: { where: string }[] }).problems.map((p) => p.where), [`objects/${BIG_CID}`], "the root named");
      assertEqual(open.created, 1, "the destination was made");
      await assertRejects(async () => opened(h, target), "NotAVault", "the unready destination");
      await assertRejects(() => lazy.vault.objects.has(BIG_CID), "DamagedObject", "the damage is known to the runtime now");
      await lazy.close();
    },
  },
  {
    name: "the cut cannot be mixed: a commit, a collection pass and a rewrap issued while the destination is being built wait for the writer to close, then land without changing the file",
    run: async (h) => {
      const c = clock();
      const { vault } = await make(h, h.fresh(), c.now);
      const [first] = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: WORLD },
        ],
        [draft([HELLO_CID, WORLD_CID])]
      );
      let admit!: () => void;
      const gate = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const target = h.fresh();
      const open: OpenDestination = async (mode) => {
        if (mode === "create") await gate;
        return h.open(target, mode);
      };
      const exporting = exportVault(vault, open, { heldRoots: rootsOf });
      await settled(Promise.resolve());
      const committing = vault.vault.commit([], [draft([HELLO_CID], { later: true })]);
      const collecting = vault.collect(rootsExcept(WORLD_CID));
      const rewrapping = vault.keystore.rewrap(REWRAPPED);
      assertEqual([await settled(committing), await settled(collecting), await settled(rewrapping)], [false, false, false], "all three wait");
      assertEqual(await settled(exporting), false, "the export waits on the gate");
      admit();
      assertEqual(await exporting, { events: 1, objects: 2, bytes: 10 }, "the export's cut");
      const bytes = await h.fileBytes(target);
      assertEqual((await committing).length, 1, "the commit landed after");
      assertEqual(await collecting, { removed: [WORLD_CID] }, "the collection pass removed the world after");
      await rewrapping;
      assertEqual(await vault.keystore.read(), REWRAPPED, "the rewrap landed after");
      assertBytes(await h.fileBytes(target), bytes, "the file is as the export left it");
      const snapshot = await opened(h, target);
      try {
        assertEqual(snapshot.wrapped, WRAPPED, "the wrapper of the cut");
        assertEqual((await all(snapshot.vault.events.scan())).map((e) => e.eventId), [first?.eventId], "the event of the cut");
        assertBytes((await snapshot.vault.objects.read(WORLD_CID, 5)) as Uint8Array, WORLD, "the world, collected from the runtime since");
        assertEqual(await validatePortable(snapshot, { heldRoots: rootsOf }), { events: 1, objects: 2, bytes: 10 }, "validated");
      } finally {
        snapshot.close();
      }
      await vault.close();
    },
  },
  {
    name: "a vault in memory exports into the same file, which reads back in SQLite",
    run: async (h) => {
      const c = clock();
      const memory = new MemoryVault({ metadata: META, wrapped: WRAPPED, now: c.now, extentBytes: 700 });
      const events = await memory.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: BIG_CID, source: BIG },
        ],
        [draft([HELLO_CID, BIG_CID]), draft([HELLO_CID])]
      );
      const target = h.fresh();
      assertEqual(await exportVault(memory as VaultRuntime, destination(h, target), { heldRoots: rootsOf }), { events: 2, objects: 2, bytes: 5 + BIG.length }, "the export");
      const snapshot = await opened(h, target);
      try {
        assertEqual(snapshot.wrapped, WRAPPED, "the wrapper");
        assertEqual(ids(await all(snapshot.vault.events.scan())), ids(events), "the events");
        assertEqual(rows(snapshot.driver, "SELECT chunk_no, length(bytes) AS n FROM object_chunks WHERE cid = ? ORDER BY chunk_no", BIG_CID), [{ chunk_no: 0, n: MIB }, { chunk_no: 1, n: MIB }, { chunk_no: 2, n: 7 }], "the format's chunks, whatever the extents in memory were");
        assertBytes((await snapshot.vault.objects.read(BIG_CID, BIG.length)) as Uint8Array, BIG, "the big object");
      } finally {
        snapshot.close();
      }
      const bare = new MemoryVault({ metadata: META });
      await assertRejects(() => exportVault(bare, destination(h, h.fresh()), { heldRoots: rootsOf }), "NotAVault", "a vault in memory given no wrapper exports nothing");
    },
  },
  {
    name: "validation refuses what an inspection alone lets through: a broken reference, an object no event holds, a held object missing, a damaged or missing chunk, an altered event, a size that lies; and a bound passed is refused before a chunk is read",
    run: async (h) => {
      const alterations: [string, (driver: SqliteDriver, events: Event[]) => void, RegExp, RegExp][] = [
        ["a chunk referencing no object", (d) => d.exec(`PRAGMA foreign_keys = OFF; DELETE FROM objects WHERE cid = '${HELLO_CID}'`), /^object_chunks\/rowid \d+$/, /references a row objects does not have/],
        [
          "an object no event holds",
          (d) => {
            exec(d, "INSERT INTO objects (cid, size) VALUES (?, 5)", WORLD_CID);
            exec(d, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 0, ?)", WORLD_CID, WORLD);
          },
          new RegExp(`^objects/${WORLD_CID}$`),
          /not held by any event/,
        ],
        ["a held object missing", (d) => d.exec(`DELETE FROM object_chunks WHERE cid = '${HELLO_CID}'; DELETE FROM objects WHERE cid = '${HELLO_CID}'`), new RegExp(`^objects/${HELLO_CID}$`), /held by the events but not in the snapshot/],
        ["a damaged chunk", (d) => corruptChunk(d, BIG_CID, 2), new RegExp(`^objects/${BIG_CID}$`), /do not hash/],
        ["a missing chunk", (d) => exec(d, "DELETE FROM object_chunks WHERE cid = ? AND chunk_no = 1", BIG_CID), new RegExp(`^objects/${BIG_CID}$`), /chunk 1 is missing/],
        ["an altered event", (d, events) => damageEvent(d, events[1] as Event), /^events\/[0-9a-f-]{36}$/, /unterminated/],
        ["a size that lies", (d) => exec(d, "UPDATE objects SET size = 6 WHERE cid = ?", HELLO_CID), new RegExp(`^objects/${HELLO_CID}$`), /5 bytes, not the 6/],
      ];
      for (const [what, alter, where, error] of alterations) {
        const { target, events } = await exported(h);
        await altered(h, target, (d) => alter(d, events));
        const snapshot = await opened(h, target);
        try {
          const err = await assertRejects(() => validatePortable(snapshot, { heldRoots: rootsOf }), "InvalidSnapshot", what);
          const [problem] = (err as unknown as { problems: { where: string; error: string }[] }).problems;
          assert(problem !== undefined && where.test(problem.where), `${what}: placed at ${problem?.where}`);
          assert(error.test(problem.error), `${what}: ${problem.error}`);
        } finally {
          snapshot.close();
        }
      }
      const { target } = await exported(h);
      const snapshot = await opened(h, target);
      try {
        let read = 0;
        const counting: HeldRoots = async (v) => {
          read += 1;
          return rootsOf(v);
        };
        const err = await assertRejects(() => validatePortable(snapshot, { heldRoots: counting, maxBytes: BIG.length }), "SnapshotTooLarge", "over the bound");
        assertEqual([(err as unknown as { maxBytes: number; bytes: number }).maxBytes, (err as unknown as { bytes: number }).bytes], [BIG.length, BIG.length + 5], "the bound and the size");
        assertEqual(read, 0, "the roots were not folded");
        assertEqual(await validatePortable(snapshot, { heldRoots: counting, maxBytes: BIG.length + 5 }), { events: 3, objects: 3, bytes: BIG.length + 5 }, "at the bound");
        await assertRejects(() => validatePortable(snapshot, { heldRoots: async () => ["nope" as Cid] }), "InvalidCid", "a fold that names no CID");
      } finally {
        snapshot.close();
      }
    },
  },
];
