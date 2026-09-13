/**
 * Export, portable validation and inspection on whatever the
 * platform's driver is, as cases free of any test framework: run over
 * `node:sqlite` by `export.test.ts` and over the wasm pool in a
 * Chromium Worker by `browser-driver.test.ts`. What the two platforms'
 * SQLite must agree on: what a snapshot holds and what never enters
 * it, the refusals before and after the destination is made, the cut
 * held against the operations waiting on the lock, the vault in
 * memory exporting into the same file, every way a snapshot that
 * opens can still fail validation, and an object of 64 MiB streamed
 * through a commit, a read, an export and a restore under bounded
 * memory.
 */

import {
  MemoryVault,
  SqliteVault,
  canonicalEventBytes,
  createRuntime,
  exportVault,
  hashSource,
  openPortable,
  restoreVault,
  validatePortable,
  type Cid,
  type Event,
  type HeldRoots,
  type OpenDestination,
  type PortableDatabase,
  type SqlRow,
  type SqlValue,
  type SqliteDriver,
  type SqliteStatement,
  type Validated,
  type VaultRuntime,
} from "../../../src/v3/index.js";
import { ANCHOR, META, REWRAPPED, WRAPPED } from "../fixtures.js";
import { assert, assertBytes, assertEqual, assertRejects } from "./driver-cases.js";
import { HELLO, HELLO_CID, MIB, WORLD, WORLD_CID, all, bytesOf, cidOf, clock, corruptChunk, damageEvent, draft, exec, make, rootsOf, rows, type VaultHarness } from "./vault-cases.js";

export interface ExportHarness extends VaultHarness {
  /** The complete bytes of the file at `target`, which no connection holds open. */
  fileBytes(target: string): Promise<Uint8Array>;
  /** What the platform reports as held, in bytes: SQLite's own count where the runtime exposes it; where it does not, what JavaScript holds once garbage is collected. */
  memoryUsed?: () => number;
}

export interface ExportCase {
  name: string;
  run(harness: ExportHarness): Promise<string | void>;
}

const EMPTY = new Uint8Array(0);
const EMPTY_CID = cidOf(EMPTY);
const BIG = bytesOf(2 * MIB + 7, 11);
const BIG_CID = cidOf(BIG);

/** Every root but `except`: what a fold that had released that object would compute. */
const rootsExcept =
  (except: Cid): HeldRoots =>
  async (vault) =>
    (await rootsOf(vault)).filter((cid) => cid !== except);

/** An opener over the harness for `target`, counting the destinations it created. */
export function destination(h: ExportHarness, target: string): OpenDestination & { created: number } {
  const open = (async (mode: "create" | "readonly") => {
    if (mode === "create") open.created += 1;
    return h.open(target, mode);
  }) as OpenDestination & { created: number };
  open.created = 0;
  return open;
}

export async function opened(h: ExportHarness, target: string): Promise<PortableDatabase> {
  return openPortable(await h.open(target, "readonly"));
}

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Has `p` settled by the time the runnable work has run? */
export async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  return done;
}

const ids = (events: Event[]): string[] => events.map((e) => e.eventId).sort();

function expectedValidated(events: Event[], objects: number, objectBytes: number): Validated {
  return { events: events.length, eventBytes: events.reduce((n, e) => n + canonicalEventBytes(e).length, 0), objects, objectBytes };
}

function countingEncodes(): { count(): number; restore(): void } {
  const encode = TextEncoder.prototype.encode;
  let count = 0;
  TextEncoder.prototype.encode = function (this: TextEncoder, input?: string): Uint8Array {
    count += 1;
    return encode.call(this, input);
  };
  return {
    count: () => count,
    restore: () => {
      TextEncoder.prototype.encode = encode;
    },
  };
}

/** `driver` with every statement watched for the largest BLOB it ever handed back. */
function observing(driver: SqliteDriver): { driver: SqliteDriver; largest(): number; reset(): void } {
  let largest = 0;
  const bound = <T extends object>(target: T, property: string | symbol): unknown => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  };
  const watched = new Proxy(driver, {
    get: (target, property) =>
      property !== "prepare"
        ? bound(target, property)
        : (sql: string): SqliteStatement => {
            const statement = target.prepare(sql);
            return new Proxy(statement, {
              get: (inner, member) =>
                member !== "all"
                  ? bound(inner, member)
                  : (...params: SqlValue[]): SqlRow[] => {
                      const rows = inner.all(...params);
                      for (const row of rows) for (const value of Object.values(row)) if (value instanceof Uint8Array) largest = Math.max(largest, value.length);
                      return rows;
                    },
            });
          },
  });
  return {
    driver: watched,
    largest: () => largest,
    reset: () => {
      largest = 0;
    },
  };
}

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
export async function altered(h: ExportHarness, target: string, body: (driver: SqliteDriver) => void): Promise<void> {
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
      assertEqual(await exportVault(vault, open, { heldRoots }), expectedValidated(events, 3, 5 + BIG.length), "what the export reports");
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
        assertEqual(await validatePortable(snapshot, { heldRoots }), expectedValidated(events, 3, 5 + BIG.length), "validated again");
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
      const later = await vault.vault.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID], { i: 3 })]);
      const second = h.fresh();
      assertEqual(await exportVault(vault, destination(h, second), { heldRoots }), expectedValidated([...events, ...later], 4, 10 + BIG.length), "the second export");
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
    name: "an export is refused before the destination is made when the history has damage, a held root is absent or known damaged, or the cut passes the byte bound, and not for a conflict on record; a root whose bytes fail as they are copied leaves the destination unready",
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
      const fine = h.fresh();
      const accepted = await all(vault.vault.events.scan());
      assertEqual(await exportVault(vault, destination(h, fine), { heldRoots: rootsOf }), expectedValidated(accepted, 1, 5), "exported with the conflict on record: a diagnostic, not damage");
      assertEqual((await vault.vault.events.conflicting()).length, 1, "the diagnostic stays with the runtime");
      const carried = await opened(h, fine);
      try {
        assertEqual((await all(carried.vault.events.scan({ author: foreign?.author }))).map((e) => e.data), [foreign?.data], "the accepted value travels");
        assertEqual(await carried.vault.events.conflicting(), [], "the diagnostic does not");
      } finally {
        carried.close();
      }
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
      const events = await vault.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: WORLD },
        ],
        [draft([HELLO_CID, WORLD_CID])]
      );
      const [first] = events;
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
      assertEqual(await exporting, expectedValidated(events, 2, 10), "the export's cut");
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
        assertEqual(await validatePortable(snapshot, { heldRoots: rootsOf }), expectedValidated(events, 2, 10), "validated");
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
      assertEqual(await exportVault(memory as VaultRuntime, destination(h, target), { heldRoots: rootsOf }), expectedValidated(events, 2, 5 + BIG.length), "the export");
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
    name: "validation refuses what an inspection alone lets through: a broken reference, an object no event holds, a held object missing, a damaged or missing chunk, an altered event, a size that lies; and a file past the bound is refused as it is opened, before a byte of it is handed back",
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
      const { target, events } = await exported(h);
      const size = (await h.fileBytes(target)).length;
      const over = observing(await h.open(target, "readonly"));
      const err = await assertRejects(async () => openPortable(over.driver, { maxFileBytes: size - 1 }), "SnapshotTooLarge", "a file over the bound");
      assertEqual([(err as unknown as { maxBytes: number }).maxBytes, (err as unknown as { bytes: number }).bytes], [size - 1, size], "the bound and the size");
      assertEqual(over.largest(), 0, "nothing of the file was handed back");
      await assertRejects(async () => over.driver.exec("SELECT 1"), "DatabaseClosed", "the driver is closed by the refusal");
      const snapshot = openPortable(await h.open(target, "readonly"), { maxFileBytes: size });
      try {
        assertEqual(await validatePortable(snapshot, { heldRoots: rootsOf }), expectedValidated(events, 3, BIG.length + 5), "validated at the bound");
        await assertRejects(() => validatePortable(snapshot, { heldRoots: async () => ["nope" as Cid] }), "InvalidCid", "a fold that names no CID");
      } finally {
        snapshot.close();
      }
    },
  },
  {
    name: "the bound counts the events, tallied before one is read: a history of large events and no object is refused at export with no event loaded, no fold run and no destination made",
    run: async (h) => {
      const c = clock();
      const watched = observing(await h.open(h.fresh(), "create"));
      const vault = new SqliteVault(createRuntime(watched.driver, { metadata: META, wrapped: WRAPPED }), { now: c.now });
      const events = await vault.vault.commit(
        [],
        Array.from({ length: 8 }, (_, i) => draft([], { i, text: "x".repeat(128 * 1024) }))
      );
      const payload = expectedValidated(events, 0, 0);
      assert(payload.eventBytes > MIB, `the events weigh ${payload.eventBytes} bytes`);
      let folded = 0;
      const counting: HeldRoots = async (v) => {
        folded += 1;
        return rootsOf(v);
      };
      watched.reset();
      const refused = destination(h, h.fresh());
      const early = await assertRejects(() => exportVault(vault, refused, { heldRoots: counting, maxBytes: payload.eventBytes - 1 }), "SnapshotTooLarge", "over the bound at export");
      assertEqual((early as unknown as { bytes: number }).bytes, payload.eventBytes, "the events counted");
      assertEqual([refused.created, folded, watched.largest()], [0, 0, 0], "no destination made, no fold run, no value handed back");
      const target = h.fresh();
      assertEqual(await exportVault(vault, destination(h, target), { heldRoots: counting, maxBytes: payload.eventBytes }), payload, "at the bound");
      await vault.close();
      const memory = new MemoryVault({ metadata: META, wrapped: WRAPPED, now: c.now });
      const inMemory = await memory.vault.commit([], [draft([], { text: "x".repeat(4 * MIB) })]);
      const weight = expectedValidated(inMemory, 0, 0).eventBytes;
      const refusedInMemory = destination(h, h.fresh());
      let foldedInMemory = 0;
      const encoded = countingEncodes();
      try {
        await assertRejects(
          () =>
            exportVault(memory as VaultRuntime, refusedInMemory, {
              heldRoots: async (v) => {
                foldedInMemory += 1;
                return rootsOf(v);
              },
              maxBytes: weight - 1,
            }),
          "SnapshotTooLarge",
          "the vault in memory tallies the same way"
        );
      } finally {
        encoded.restore();
      }
      assertEqual([refusedInMemory.created, foldedInMemory, encoded.count()], [0, 0, 0], "no destination made, no fold run, no held text encoded to weigh it");
    },
  },
  {
    name: "a chunk longer than the layout gives it is refused by its length: a read never loads it, and validation refuses the file before its integrity is checked",
    run: async (h) => {
      const { target } = await exported(h);
      const oversized = 16 * MIB;
      await altered(h, target, (d) => {
        d.exec(`DROP TABLE object_chunks;
          CREATE TABLE object_chunks (
            cid TEXT COLLATE BINARY NOT NULL REFERENCES objects(cid) ON DELETE CASCADE,
            chunk_no INTEGER NOT NULL,
            bytes BLOB NOT NULL,
            PRIMARY KEY (cid, chunk_no)
          ) STRICT`);
        exec(d, "INSERT INTO object_chunks (cid, chunk_no, bytes) VALUES (?, 0, zeroblob(?))", HELLO_CID, oversized);
      });
      const watched = observing(await h.open(target, "readonly"));
      const snapshot = openPortable(watched.driver);
      try {
        await assertRejects(() => snapshot.vault.objects.read(HELLO_CID, 5), "DamagedObject", "a read of the object");
        const err = await assertRejects(() => validatePortable(snapshot, { heldRoots: rootsOf }), "InvalidSnapshot", "validation");
        const [problem] = (err as unknown as { problems: { where: string; error: string }[] }).problems;
        assertEqual(problem?.where, "object_chunks", "placed at the chunk table");
        assert(new RegExp(`hold ${oversized} bytes where the objects declare ${BIG.length + 5}`).test(problem?.error ?? ""), `the sums: ${problem?.error}`);
        assert(watched.largest() <= MIB, `a statement handed back ${watched.largest()} bytes`);
      } finally {
        snapshot.close();
      }
    },
  },
  {
    name: "a CHECK the file declares is neither trusted nor run: a file whose constraint every row violates validates on its values",
    run: async (h) => {
      const { target, events } = await exported(h);
      await altered(h, target, (d) => {
        const objects = rows(d, "SELECT cid, size FROM objects");
        d.exec(`PRAGMA foreign_keys = OFF;
          DROP TABLE objects;
          CREATE TABLE objects (cid TEXT COLLATE BINARY PRIMARY KEY NOT NULL, size INTEGER NOT NULL CHECK (size < 0)) STRICT;
          PRAGMA ignore_check_constraints = ON`);
        for (const row of objects) exec(d, "INSERT INTO objects (cid, size) VALUES (?, ?)", row["cid"] as string, row["size"] as number);
        d.exec("PRAGMA ignore_check_constraints = OFF");
        assertEqual(rows(d, "PRAGMA integrity_check").length, objects.length, "the writer, which runs the constraint, sees every row violate it");
      });
      const snapshot = await opened(h, target);
      try {
        assertEqual(await validatePortable(snapshot, { heldRoots: rootsOf }), expectedValidated(events, 3, BIG.length + 5), "validated on the values");
      } finally {
        snapshot.close();
      }
    },
  },
  {
    name: "an object of 64 MiB streams through a commit, a read, an export and a restore, and what the platform holds stays bounded throughout",
    run: async (h) => {
      const total = 64;
      const piece = new Uint8Array(MIB); // one buffer, refilled: nothing here holds the object
      async function* source(): AsyncIterable<Uint8Array> {
        for (let i = 0; i < total; i++) {
          piece.fill(i + 1);
          yield piece;
        }
      }
      const { cid } = await hashSource(source(), total * MIB, () => undefined);
      const id = cid.text as Cid;
      const held: [string, number][] = [];
      const sample = (at: string): void => {
        if (h.memoryUsed !== undefined) held.push([at, h.memoryUsed()]);
      };
      const { vault } = await make(h, h.fresh(), clock().now);
      sample("before");
      let fed = 0;
      async function* sampled(): AsyncIterable<Uint8Array> {
        for await (const chunk of source()) {
          yield chunk;
          if (++fed % 32 === 0) sample(`${fed} MiB into the commit`);
        }
      }
      await vault.vault.commit([{ cid: id, source: sampled() }], [draft([id])]);
      sample("after the commit");
      const stream = await vault.vault.objects.open(id);
      assert(stream !== null, "readable");
      const reader = stream.getReader();
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; ) {
          const mebibyte = Math.floor((offset + i) / MIB);
          const end = Math.min(value.length, (mebibyte + 1) * MIB - offset);
          for (; i < end; i++) if (value[i] !== mebibyte + 1) throw new Error(`byte ${offset + i} read back as ${value[i]}, not ${mebibyte + 1}`);
        }
        const before = offset;
        offset += value.length;
        if (Math.floor(offset / (32 * MIB)) > Math.floor(before / (32 * MIB))) sample(`${Math.floor(offset / MIB)} MiB into the read`);
      }
      assertEqual(offset, total * MIB, "read whole");
      const target = h.fresh();
      const exported = await exportVault(vault, destination(h, target), { heldRoots: rootsOf });
      assertEqual(exported.objectBytes, total * MIB, "exported whole");
      sample("after the export");
      const snapshot = await opened(h, target);
      const restored = await restoreVault(snapshot, destination(h, h.fresh()), { heldRoots: rootsOf, anchor: ANCHOR });
      snapshot.close();
      assertEqual([restored.objects, restored.objectBytes], [1, total * MIB], "restored whole");
      restored.runtime.close();
      sample("after the restore");
      await vault.close();
      if (held.length === 0) return;
      const note = held.map(([at, n]) => `${at}: ${(n / MIB).toFixed(1)} MiB`).join(", ");
      const at = (mark: string): number => {
        const found = held.find(([name]) => name === mark);
        if (found === undefined) throw new Error(`no sample ${mark}: ${note}`);
        return found[1];
      };
      const grewBy = (from: string, to: string): number => at(to) - at(from);
      assert(grewBy("32 MiB into the commit", "64 MiB into the commit") < 4 * MIB, `the second half of the commit's source held no more than the first: ${note}`);
      assert(grewBy("32 MiB into the read", "64 MiB into the read") < 4 * MIB, `the second half of the read held no more than the first: ${note}`);
      assert(grewBy("after the commit", "after the restore") < 4 * MIB, `the export and the restore held no more than the commit left: ${note}`);
      assert(grewBy("before", "after the restore") < 32 * MIB, `less than half the object held in all, a page cache filled by the commit being a fixed cost: ${note}`);
      return note;
    },
  },
];
