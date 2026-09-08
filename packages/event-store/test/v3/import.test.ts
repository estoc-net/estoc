/**
 * Import into an existing folder vault: the merged view decided under
 * the writer lock, staged and published through the barrier under
 * `import/`, and recovered by the next writable open from whatever a
 * crash left, on the memory backend and on disk.
 */

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../../src/node.js";
import {
  AnchorMismatch,
  FolderReader,
  FolderVault,
  ForkedAuthor,
  IncompleteImport,
  InvalidSnapshot,
  MemoryBackend,
  MemoryVault,
  NotAVault,
  PendingImport,
  VaultClosed,
  canonicalEventBytes,
  encodeConfig,
  encodeJournal,
  encodeLines,
  exportVault,
  importFolder,
  kindOf,
  segmentPath,
  utf8,
  type Cid,
  type Draft,
  type Event,
  type EventId,
  type Held,
  type VaultBackend,
} from "../../src/v3/index.js";
import { all, authorN, clock, expectBytes, ids, uuidv7At } from "./suite/helpers.js";
import { HELLO_CID, cidOf } from "./suite/object-store-suite.js";

const BASE = ".estoc";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const JWE = "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IkFCQ0QifQ.QUJDRA.QUJDRA.QUJDRA.QUJDRA";
const KEYSTORE = utf8(`${JSON.stringify({ version: 3, seedJwe: JWE }, null, 2)}\n`);
/** the same seed wrapped another way: equal identity does not require byte-equal seedJwe */
const OTHER_KEYSTORE = utf8(`${JSON.stringify({ version: 3, seedJwe: JWE.replace("QUJDRA.QUJDRA.QUJDRA.QUJDRA", "QUJDRA.QUJDRA.QUJDRA.WFla") }, null, 2)}\n`);
const CONFIG = encodeConfig(DID);
const HELLO = new TextEncoder().encode("hello");
const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);
const BIG = new Uint8Array(3 * 64 * 1024 + 7).map((_, i) => i % 251);
const BIG_CID = cidOf(BIG);
const HOUR = 60 * 60 * 1000;
const SEG = (n: number): string => uuidv7At(1_800_000_000_000 + n, 0x5e5e5e00 + n);
const JOB = (n: number): string => uuidv7At(1_810_000_000_000 + n, 0x10b10b00 + n);

const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

/** Every path under `base`, relative to it, sorted. */
function paths(backend: MemoryBackend, base = BASE): string[] {
  return [...backend.files.keys()]
    .filter((p) => p.startsWith(`${base}/`))
    .map((p) => p.slice(base.length + 1))
    .sort();
}

/** Every path under `base` with its bytes, for an exact before-and-after. */
function bytesOf(backend: MemoryBackend, base = BASE): Record<string, number[]> {
  return Object.fromEntries(paths(backend, base).map((p) => [p, Array.from(backend.files.get(`${base}/${p}`) as Uint8Array)]));
}

/** The held roots of every event: what the fold would say when nothing is erased. */
async function allRoots(held: Held): Promise<Cid[]> {
  const roots: Cid[] = [];
  for await (const event of held.events.scan()) roots.push(...event.roots);
  return roots;
}

/** A fold for these tests: an event's roots are held unless a `test.release` event names that event in `data.of`. */
async function retained(held: Held): Promise<Cid[]> {
  const events = await all(held.events.scan());
  const released = new Set(events.filter((e) => e.type === "test.release").map((e) => (e.data as { of: string }).of));
  return events.filter((e) => !released.has(e.eventId)).flatMap((e) => e.roots);
}

/** A vault over a fresh memory folder, created and open for writing, holding one event over BIG and its own notes. */
async function target(backend: MemoryBackend = new MemoryBackend(), options: Partial<Parameters<typeof FolderVault.create>[1]> = {}): Promise<FolderVault> {
  const vault = await FolderVault.create(backend, { anchor: DID, keystore: KEYSTORE, ...options });
  await vault.vault.commit([{ cid: BIG_CID, source: BIG }], [draft([BIG_CID], { mine: true })]);
  await vault.vault.files.write("notes.txt", utf8("target's notes"));
  return vault;
}

/**
 * A portable folder of the same vault from elsewhere: another replica's
 * event over HELLO, an event of a third author, an orphan WORLD that
 * nothing holds, its own `notes.txt`, and a file the target has not
 * got; the seed wrapped another way. The events, in canonical order.
 */
async function source(twist: (runtime: MemoryVault, other: MemoryVault) => Promise<void> = async () => undefined): Promise<{ from: MemoryBackend; events: Event[]; other: MemoryVault }> {
  const other = new MemoryVault();
  const runtime = new MemoryVault({ config: CONFIG, keystore: OTHER_KEYSTORE });
  await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { who: "source" })]);
  const [theirs] = await other.vault.commit([], [draft([], { who: "them" })]);
  await runtime.ingest([theirs as Event]);
  await runtime.vault.commit([{ cid: WORLD_CID, source: WORLD }], []);
  await runtime.vault.files.write("notes.txt", utf8("source's notes"));
  await runtime.vault.files.write("shared/from-source.txt", utf8("from the source"));
  await twist(runtime, other);
  const from = new MemoryBackend();
  await exportVault(runtime, from, { heldRoots: allRoots });
  return { from, events: await all(runtime.vault.events.scan()), other };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

/** `backend` with every `read` and `open` recorded in `reads`. */
function watching(backend: MemoryBackend, reads: string[]): VaultBackend {
  return new Proxy(backend, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop === "read" || prop === "open") {
        return (p: string) => {
          reads.push(p);
          return (value as (p: string) => unknown).call(t, p);
        };
      }
      return typeof value === "function" ? value.bind(t) : value;
    },
  });
}

describe("importFolder", () => {
  it("merges a portable folder of the same vault into an open one: the new events under fresh segments, the held roots the target lacked, the files it had nothing at; its config, keystore and own files untouched; nothing left under import/; and importing the same folder again adds nothing and writes nothing", async () => {
    const backend = new MemoryBackend();
    const vault = await target(backend);
    const before = await all(vault.vault.events.scan());
    const { token } = await vault.vault.events.changes();
    const { from, events: theirs } = await source();
    const configBefore = backend.files.get(`${BASE}/config.json`) as Uint8Array;

    const imported = await importFolder(vault, from, { heldRoots: allRoots });
    expect(imported).toEqual({ events: 2, duplicates: 0, conflicts: [], objects: 1, files: 1 });

    const after = await all(vault.vault.events.scan());
    expect(ids(after).sort()).toEqual(ids([...before, ...theirs]).sort());
    for (const event of theirs) {
      const held = after.find((e) => e.eventId === event.eventId) as Event;
      expectBytes(canonicalEventBytes(held), canonicalEventBytes(event), event.eventId);
    }
    expectBytes(await vault.vault.objects.read(HELLO_CID, 1024), HELLO);
    expectBytes(await vault.vault.objects.read(BIG_CID, BIG.length), BIG);
    expect(await vault.vault.objects.has(WORLD_CID)).toBe(false);
    expectBytes(await vault.vault.files.read("notes.txt"), utf8("target's notes"));
    expectBytes(await vault.vault.files.read("shared/from-source.txt"), utf8("from the source"));
    expectBytes(backend.files.get(`${BASE}/config.json`), configBefore);
    expectBytes(backend.files.get(`${BASE}/keystore.json`), KEYSTORE);
    const listed = paths(backend);
    expect(listed.filter((p) => p.startsWith("import/"))).toEqual([]);
    const authors = new Set(listed.filter((p) => kindOf(p) === "segment").map((p) => p.split("/")[1]));
    expect([...authors].sort()).toEqual([vault.author, ...theirs.map((e) => e.author)].sort());
    expect(await vault.damaged()).toEqual([]);

    // what a fold's cache learns after the import: exactly the events the import published
    const gained = await vault.vault.events.changes(undefined, token);
    expect(ids(await all(gained.events)).sort()).toEqual(ids(theirs).sort());

    const snapshot = bytesOf(backend);
    expect(await importFolder(vault, from, { heldRoots: allRoots })).toEqual({ events: 0, duplicates: 2, conflicts: [], objects: 0, files: 0 });
    expect(bytesOf(backend)).toEqual(snapshot);

    // the vault goes on: a commit after the import
    await vault.vault.commit([], [draft([], { later: true })]);
    expect((await all(vault.vault.events.scan())).length).toBe(4);
    await vault.close();
  });

  it("requires every held root of the merged event set to have bytes in the target or the source: one in neither refuses the import with nothing written; one the target holds is not copied; one the fold has released is not copied though the source offers it; nor is an orphan", async () => {
    const backend = new MemoryBackend();
    const vault = await target(backend);
    const nowhere = await source();
    await nowhere.from.remove(`${BASE}/objects/${HELLO_CID}`);
    const untouched = bytesOf(backend);
    const err = await importFolder(vault, nowhere.from, { heldRoots: allRoots }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompleteImport);
    expect((err as IncompleteImport).problems).toEqual([{ where: `objects/${HELLO_CID}`, error: expect.stringMatching(/neither the source nor the target/) }]);
    expect(bytesOf(backend)).toEqual(untouched);

    // the target holds BIG already: a source event over BIG needs nothing copied, and the source need not even carry it
    const overBig = await source(async (runtime) => {
      await runtime.vault.commit([{ cid: BIG_CID, source: BIG }], [draft([BIG_CID], { big: "again" })]);
    });
    await overBig.from.remove(`${BASE}/objects/${BIG_CID}`);
    expect(await importFolder(vault, overBig.from, { heldRoots: allRoots })).toMatchObject({ events: 3, objects: 1 });
    expect(paths(backend).filter((p) => kindOf(p) === "object").sort()).toEqual([`objects/${BIG_CID}`, `objects/${HELLO_CID}`].sort());

    // a root the fold releases: WORLD is offered, held by a source event, and released by another
    const released = await source(async (runtime) => {
      const [held] = await runtime.vault.commit([], [draft([WORLD_CID], { world: true })]);
      await runtime.vault.commit([], [{ type: "test.release", roots: [], data: { of: (held as Event).eventId } }]);
    });
    const fresh = await target();
    expect(await importFolder(fresh, released.from, { heldRoots: retained })).toMatchObject({ events: 4, objects: 1 });
    expect(await fresh.vault.objects.has(WORLD_CID)).toBe(false);
    expect(await fresh.vault.objects.has(HELLO_CID)).toBe(true);
    await fresh.close();
    await vault.close();
  });

  it("refuses a source holding this replica's author over events this replica did not write — new, or the same eventId with other bytes — as ForkedAuthor, with nothing written; a source holding this replica's events as written is duplicates", async () => {
    const backend = new MemoryBackend();
    const vault = await target(backend);
    const mine = (await all(vault.vault.events.scan()))[0] as Event;
    const exported = new MemoryBackend();
    await exportVault(vault, exported, { heldRoots: allRoots });
    expect(await importFolder(vault, exported, { heldRoots: allRoots })).toEqual({ events: 0, duplicates: 1, conflicts: [], objects: 0, files: 0 });

    const untouched = bytesOf(backend);
    const forkedNew = new MemoryVault({ author: vault.author, config: CONFIG, keystore: KEYSTORE });
    const [theirs] = await forkedNew.vault.commit([], [draft([], { from: "a copy of this replica" })]);
    const fromNew = new MemoryBackend();
    await exportVault(forkedNew, fromNew, { heldRoots: allRoots });
    const err = await importFolder(vault, fromNew, { heldRoots: allRoots }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForkedAuthor);
    expect((err as ForkedAuthor).author).toBe(vault.author);
    expect(ids((err as ForkedAuthor).events as Event[])).toEqual([(theirs as Event).eventId]);
    expect(bytesOf(backend)).toEqual(untouched);

    const twisted = new MemoryBackend();
    await exportVault(vault, twisted, { heldRoots: allRoots });
    const segment = paths(twisted).find((p) => kindOf(p) === "segment") as string;
    await twisted.write(`${BASE}/${segment}`, encodeLines([{ ...mine, data: { n: 2, mine: true } }]));
    await expect(importFolder(vault, twisted, { heldRoots: allRoots })).rejects.toThrow(ForkedAuthor);
    expect(bytesOf(backend)).toEqual(untouched);
    await vault.close();
  });

  it("keeps the target's event on a conflict under another author's eventId, reports it, and adds the rest", async () => {
    const backend = new MemoryBackend();
    const vault = await target(backend);
    const { from, other } = await source();
    const theirs = (await all(other.vault.events.scan()))[0] as Event;
    // the target already holds the third author's event as written; the source's copy says otherwise
    await vault.ingest([theirs]);
    const segment = paths(from).find((p) => p.startsWith(`events/${theirs.author}/`)) as string;
    const altered = { ...theirs, data: { ...theirs.data, altered: true } };
    await from.write(`${BASE}/${segment}`, encodeLines([altered]));
    const imported = await importFolder(vault, from, { heldRoots: allRoots });
    expect(imported).toMatchObject({ events: 1, duplicates: 0, objects: 1, files: 1 });
    expect(imported.conflicts).toEqual([{ eventId: theirs.eventId, kept: theirs, rejected: altered }]);
    const held = (await all(vault.vault.events.scan())).find((e) => e.eventId === theirs.eventId) as Event;
    expectBytes(canonicalEventBytes(held), canonicalEventBytes(theirs));
    expect(await vault.vault.events.conflicting()).toEqual([]);
    await vault.close();
  });

  it("refuses, with nothing written and the source's local/ and import/ unread: another vault's folder, another version, a folder with no keystore, one with an import its owner has not finished — whose journal is never executed here — and a target whose own event set has damage or a conflict", async () => {
    const backend = new MemoryBackend();
    const vault = await target(backend);
    const untouched = bytesOf(backend);
    const refused = async (from: MemoryBackend, error: unknown, pattern?: RegExp): Promise<void> => {
      const reads: string[] = [];
      const err = await importFolder(vault, watching(from, reads), { heldRoots: allRoots }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(error);
      if (pattern !== undefined) expect((err as Error).message).toMatch(pattern);
      expect(bytesOf(backend)).toEqual(untouched);
      expect(reads.some((p) => p.includes("/local/") || p.includes("/import/"))).toBe(false);
    };

    const another = new MemoryVault({ config: encodeConfig(OTHER_DID), keystore: KEYSTORE });
    await another.vault.commit([], [draft()]);
    const anotherFrom = new MemoryBackend();
    await exportVault(another, anotherFrom, { heldRoots: allRoots });
    await refused(anotherFrom, AnchorMismatch, /another vault's folder/);

    const v2 = new MemoryBackend();
    await v2.write(`${BASE}/config.json`, utf8(JSON.stringify({ format: "estoc", version: 2, identity: { anchor: { did: DID, key: "x" } } })));
    await refused(v2, NotAVault, /version/);

    const { from: noKeystore } = await source();
    await noKeystore.remove(`${BASE}/keystore.json`);
    await refused(noKeystore, InvalidSnapshot, /keystore.json/);

    const { from: pending } = await source();
    // a journal that, executed here, would put the source's keystore where the target's is
    await pending.write(`${BASE}/import/${JOB(1)}/journal.json`, encodeJournal(["keystore.json"]));
    await pending.write(`${BASE}/import/${JOB(1)}/staged/keystore.json`, OTHER_KEYSTORE);
    await pending.write(`${BASE}/local/replica.json`, utf8(`{"replica_id":"${authorN(1)}","store_generation":"${authorN(2)}"}`));
    await refused(pending, PendingImport);
    await vault.close();

    const { from } = await source();
    const damaged = new MemoryBackend();
    const damagedVault = await target(damaged);
    await damaged.write(`${BASE}/events/${damagedVault.author}/stray.txt`, utf8("x"));
    const damagedBefore = bytesOf(damaged);
    await expect(importFolder(damagedVault, from, { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: `events/${damagedVault.author}/stray.txt` }] });
    expect(bytesOf(damaged)).toEqual(damagedBefore);
    await damaged.remove(`${BASE}/events/${damagedVault.author}/stray.txt`);
    const mine = (await all(damagedVault.vault.events.scan()))[0] as Event;
    await damaged.write(`${BASE}/${segmentPath(damagedVault.author, SEG(1))}`, encodeLines([{ ...mine, data: { n: 3 } }]));
    await expect(importFolder(damagedVault, from, { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: `events:${mine.eventId}` }] });
    await damagedVault.close();
  });

  it("refuses a source file that would land where the target has a directory, or under a file of the target, with nothing written", async () => {
    const { from } = await source();
    const dir = new MemoryBackend();
    const overDir = await target(dir);
    await overDir.vault.files.write("shared/from-source.txt/inner", utf8("a directory where the source has a file"));
    const dirBefore = bytesOf(dir);
    await expect(importFolder(overDir, from, { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: "shared/from-source.txt", error: expect.stringMatching(/directory of the target/) }] });
    expect(bytesOf(dir)).toEqual(dirBefore);
    await overDir.close();

    const file = new MemoryBackend();
    const underFile = await target(file);
    await underFile.vault.files.write("shared", utf8("a file where the source has a directory"));
    const fileBefore = bytesOf(file);
    await expect(importFolder(underFile, from, { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: "shared/from-source.txt", error: expect.stringMatching(/shared is a file of the target/) }] });
    expect(bytesOf(file)).toEqual(fileBefore);
    await underFile.close();
  });

  /** A source whose `open` waits at the gate before handing out the first object's bytes: an import held mid-copy. */
  class GatedOpen extends MemoryBackend {
    gate: Promise<void> | null = null;
    constructor(from: MemoryBackend) {
      super();
      for (const [key, bytes] of from.files) this.files.set(key, bytes);
    }
    override async open(path: string): Promise<ReadableStream<Uint8Array> | null> {
      if (this.gate !== null && path.includes("/objects/")) {
        const wait = this.gate;
        this.gate = null;
        await wait;
      }
      return super.open(path);
    }
  }

  it("holds the writer lock from the first look at the target through publication: the held roots are computed inside it, and a commit, a file write and a collection pass wait for it", async () => {
    const t = clock("2026-09-08T10:00:00.000Z");
    const backend = new MemoryBackend({ clock: () => new Date(t.now()) });
    const vault = await target(backend, { now: t.now, graceMs: HOUR });
    await vault.vault.commit([{ cid: WORLD_CID, source: WORLD }], []); // an orphan, old enough to collect once the import is done
    t.advance(2 * HOUR);
    const { from } = await source();
    const gated = new GatedOpen(from);
    const g = gate();
    gated.gate = g.wait;
    let insideLock = false;
    const importing = importFolder(vault, gated, {
      heldRoots: async (held) => {
        insideLock = vault.lock.held;
        return allRoots(held);
      },
    });
    await tick();
    expect(insideLock).toBe(true);
    const order: string[] = [];
    const collecting = vault.collect(allRoots).then((c) => order.push(`collect ${c.unlinked.length}`));
    const committing = vault.vault.commit([], [draft([], { late: true })]).then(() => order.push("commit"));
    const writing = vault.vault.files.write("late.txt", utf8("late")).then(() => order.push("write"));
    await tick();
    expect(order).toEqual([]);
    expect(paths(backend)).not.toContain(`objects/${HELLO_CID}`);
    g.open();
    const imported = await importing;
    order.push("import");
    await Promise.all([collecting, committing, writing]);
    expect(order).toEqual(["import", "collect 1", "commit", "write"]);
    expect(imported).toMatchObject({ events: 2, objects: 1, files: 1 });
    expect(await vault.vault.objects.has(WORLD_CID)).toBe(false);
    expect(await vault.vault.objects.has(HELLO_CID)).toBe(true);
    expect(paths(backend).some((p) => p.startsWith("import/"))).toBe(false);
    await vault.close();
  });
});

/** A backend that fails its n-th change — write, create, rename or remove — and every one after, until revived: the process crashing there, and restarting. */
class FailingBackend extends MemoryBackend {
  failAt = Infinity;
  count = 0;
  down = false;
  private hit(): void {
    if (this.down) throw new Error("the backend is down");
    this.count += 1;
    if (this.count >= this.failAt) {
      this.down = true;
      throw new Error("the backend is down");
    }
  }
  override async write(path: string, data: Uint8Array): Promise<void> {
    this.hit();
    return super.write(path, data);
  }
  override async create(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    this.hit();
    return super.create(path, source);
  }
  override async rename(from: string, to: string): Promise<void> {
    this.hit();
    return super.rename(from, to);
  }
  override async remove(path: string): Promise<void> {
    this.hit();
    return super.remove(path);
  }
  revive(): void {
    this.down = false;
    this.failAt = Infinity;
  }
}

function cloned<T extends MemoryBackend>(from: MemoryBackend, into: T): T {
  for (const [key, bytes] of from.files) into.files.set(key, new Uint8Array(bytes));
  return into;
}

describe("the barrier under import/", () => {
  /** A prepared target, closed, and the source to import into it; the target's events, and the events the union adds. */
  async function prepared(): Promise<{ folder: MemoryBackend; from: MemoryBackend; before: string[]; added: string[] }> {
    const folder = new MemoryBackend();
    const vault = await target(folder);
    const before = ids(await all(vault.vault.events.scan()));
    await vault.close();
    const { from, events } = await source();
    return { folder, from, before, added: ids(events) };
  }

  /** What one crash at the n-th change left, and what the restart found. */
  interface Outcome {
    n: number;
    journaled: boolean;
    partial: boolean;
    view: "before" | "union";
  }

  async function crashAt(n: number, wipeLocal: boolean): Promise<Outcome | "completed"> {
    const { folder, from, before, added } = await prepared();
    const backend = cloned(folder, new FailingBackend());
    const vault = await FolderVault.openWritable(backend, { anchor: DID });
    backend.failAt = n;
    backend.count = 0;
    const result = await importFolder(vault, from, { heldRoots: allRoots }).then(() => "completed" as const, (err: unknown) => err);
    if (result === "completed") {
      await vault.close();
      return "completed";
    }
    expect((result as Error).message).toMatch(/the backend is down/);
    // what the crash left: whether the union is half published, and whether publication had begun — a runtime that has written the journal and could not finish closes itself
    const journaled = !vault.open;
    const published = paths(backend).filter((p) => !p.startsWith("import/"));
    const hasSegment = published.some((p) => kindOf(p) === "segment" && !p.startsWith(`events/${vault.author}/`));
    const hasObject = published.includes(`objects/${HELLO_CID}`);
    const hasFile = published.includes("shared/from-source.txt");
    const some = hasSegment || hasObject || hasFile;
    const whole = hasSegment && hasObject && hasFile;
    const partial = some && !whole;
    if (paths(backend).some((p) => p.startsWith("import/") && p.endsWith("/journal.json"))) expect(journaled, `n=${n}`).toBe(true);
    if (journaled) await expect(vault.vault.commit([], [draft()]), `n=${n}`).rejects.toThrow(VaultClosed);
    else expect(some, `n=${n}: nothing is published before the journal`).toBe(false);
    await vault.close();
    // before the restart: a read-only open shows the previous view, or the whole union, or reports the import — never a partial union
    const reader = await FolderReader.open(backend).then((r) => r, (err: unknown) => err);
    if (reader instanceof FolderReader) {
      const seen = ids(await all(reader.events.scan())).sort();
      if (seen.join() === [...before].sort().join()) expect(some, `n=${n}`).toBe(false);
      else {
        expect(seen, `n=${n}`).toEqual([...before, ...added].sort());
        expect(whole, `n=${n}`).toBe(true);
      }
      await reader.close();
    } else expect(reader, `n=${n}`).toBeInstanceOf(PendingImport);
    // the restart
    backend.revive();
    if (wipeLocal) for (const key of [...backend.files.keys()].filter((k) => k.startsWith(`${BASE}/local/`))) backend.files.delete(key);
    const reopened = await FolderVault.openWritable(backend, { anchor: DID });
    expect(paths(backend).filter((p) => p.startsWith("import/")), `n=${n}`).toEqual([]);
    expect(await reopened.damaged(), `n=${n}`).toEqual([]);
    const events = ids(await all(reopened.vault.events.scan())).sort();
    const union = [...before, ...added].sort();
    let view: Outcome["view"];
    if (events.join() === union.join()) {
      view = "union";
      expectBytes(await reopened.vault.objects.read(HELLO_CID, 1024), HELLO, `n=${n}`);
      expectBytes(await reopened.vault.files.read("shared/from-source.txt"), utf8("from the source"), `n=${n}`);
    } else {
      view = "before";
      expect(events, `n=${n}`).toEqual([...before].sort());
      expect(await reopened.vault.objects.has(HELLO_CID), `n=${n}`).toBe(false);
      expect(await reopened.vault.files.read("shared/from-source.txt"), `n=${n}`).toBeNull();
    }
    expect(journaled ? "union" : "before", `n=${n}: a journal is finished, staging is rolled back`).toBe(view);
    // the import again, on the recovered vault: the union either way, and a no-op where it already stood
    const again = await importFolder(reopened, from, { heldRoots: allRoots });
    expect(again.events + again.duplicates, `n=${n}`).toBe(added.length);
    expect(again.events, `n=${n}`).toBe(view === "union" ? 0 : added.length);
    expect(ids(await all(reopened.vault.events.scan())).sort(), `n=${n}`).toEqual(union);
    await reopened.close();
    return { n, journaled, partial, view };
  }

  for (const wipeLocal of [false, true]) {
    it(`a crash at every change of an import leaves the previous view or a recoverable import, which the next writable open finishes or rolls back${wipeLocal ? " — with local/ deleted meanwhile" : ""}`, async () => {
      const outcomes: Outcome[] = [];
      for (let n = 1; n < 100; n++) {
        const outcome = await crashAt(n, wipeLocal);
        if (outcome === "completed") break;
        outcomes.push(outcome);
        expect(n).toBeLessThan(99);
      }
      expect(outcomes.length).toBeGreaterThan(8);
      expect(outcomes.some((o) => !o.journaled)).toBe(true);
      expect(outcomes.some((o) => o.journaled && o.partial)).toBe(true);
      expect(outcomes.some((o) => o.journaled && !o.partial)).toBe(true);
      expect(outcomes.filter((o) => o.view === "before").length).toBeGreaterThan(0);
      expect(outcomes.filter((o) => o.view === "union").length).toBeGreaterThan(0);
    });
  }

  it("a writable open finishes a journaled import it finds — items still staged moved, ones already at their place left — and rolls back staging with no journal; a read-only open takes up neither and reports both", async () => {
    const folder = new MemoryBackend();
    const vault = await target(folder);
    const author = authorN(5);
    const event: Event = { eventId: uuidv7At(1_700_000_000_500, 0x5) as EventId, at: "2023-11-14T22:13:20.500Z", author, type: "test.event", roots: [HELLO_CID], data: { staged: true } };
    await vault.close();
    const segment = segmentPath(author, SEG(9));
    const job = `${BASE}/import/${JOB(2)}`;
    await folder.write(`${job}/journal.json`, encodeJournal([segment, `objects/${HELLO_CID}`, "shared/staged.txt"]));
    await folder.write(`${job}/staged/${segment}`, encodeLines([event]));
    await folder.write(`${BASE}/objects/${HELLO_CID}`, HELLO); // already at its place: moved before the crash
    await folder.write(`${job}/staged/shared/staged.txt`, utf8("staged"));
    await folder.write(`${BASE}/import/${JOB(3)}/staged/objects/${WORLD_CID}`, new Uint8Array([1, 2, 3])); // staging that never reached a journal
    await expect(FolderReader.open(folder)).rejects.toThrow(PendingImport);
    const opened = await FolderVault.openWritable(folder, { anchor: DID });
    expect(paths(folder).filter((p) => p.startsWith("import/"))).toEqual([]);
    expect(ids(await all(opened.vault.events.scan()))).toContain(event.eventId);
    expectBytes(folder.files.get(`${BASE}/${segment}`), encodeLines([event]));
    expectBytes(await opened.vault.files.read("shared/staged.txt"), utf8("staged"));
    expectBytes(await opened.vault.objects.read(HELLO_CID, 1024), HELLO);
    expect(await opened.vault.objects.has(WORLD_CID)).toBe(false);
    expect(await opened.damaged()).toEqual([]);
    await opened.close();
    const reader = await FolderReader.open(folder);
    expect(ids(await all(reader.events.scan()))).toContain(event.eventId);
    await reader.close();
  });

  it("blocks a writable open, touching nothing under import/, on what it does not understand: a file at the top, a directory not an import's, a journal that does not parse or names a path of another shape — the config, the keystore, local/ — a staged file the journal does not name, an item found neither staged nor at its place; and a well-formed import beside any of them is left alone too", async () => {
    const cases: [string, (folder: MemoryBackend) => Promise<void>, RegExp][] = [
      ["a file at the top", (f) => f.write(`${BASE}/import/journal.json`, encodeJournal([])), /file directly under import/],
      ["a directory not an import's", (f) => f.write(`${BASE}/import/pending/journal.json`, encodeJournal([])), /not an import this version recorded/],
      ["a journal that does not parse", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, utf8("{")), /journal.json/],
      ["a journal of another shape", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, utf8('{"format":"estoc-import","version":1,"items":[],"extra":1}')), /members are/],
      ["a journal of another version", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, utf8('{"format":"estoc-import","version":2,"items":[]}')), /version 2 is not 1/],
      ["a journal naming config.json", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, encodeJournal(["config.json"])), /config.json is not a path an import publishes/],
      ["a journal naming keystore.json", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, encodeJournal(["keystore.json"])), /keystore.json is not a path/],
      ["a journal naming local/", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, encodeJournal(["local/replica.json"])), /local\/replica.json is not a path/],
      ["a journal naming a path twice", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, utf8(`{"format":"estoc-import","version":1,"items":["a.txt","a.txt"]}`)), /named twice/],
      [
        "a staged file the journal does not name",
        async (f) => {
          await f.write(`${BASE}/import/${JOB(4)}/journal.json`, encodeJournal(["a.txt"]));
          await f.write(`${BASE}/import/${JOB(4)}/staged/a.txt`, utf8("a"));
          await f.write(`${BASE}/import/${JOB(4)}/staged/b.txt`, utf8("b"));
        },
        /staged\/b.txt is neither the journal nor an item it names/,
      ],
      ["an item neither staged nor at its place", (f) => f.write(`${BASE}/import/${JOB(4)}/journal.json`, encodeJournal(["a.txt"])), /a.txt is neither staged nor at its place/],
      ["staging beside a file that is not staging", (f) => f.write(`${BASE}/import/${JOB(4)}/notes`, utf8("?")), /not staging, and there is no journal/],
    ];
    for (const [name, twist, detail] of cases) {
      const folder = new MemoryBackend();
      const vault = await target(folder);
      await vault.close();
      // a well-formed import beside it, recoverable on its own
      await folder.write(`${BASE}/import/${JOB(1)}/journal.json`, encodeJournal(["fine.txt"]));
      await folder.write(`${BASE}/import/${JOB(1)}/staged/fine.txt`, utf8("fine"));
      await twist(folder);
      const before = bytesOf(folder);
      const err = await FolderVault.openWritable(folder, { anchor: DID }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(PendingImport);
      expect((err as PendingImport).message, name).toMatch(detail);
      expect(bytesOf(folder), name).toEqual(before);
      await expect(FolderReader.open(folder), name).rejects.toThrow(PendingImport);
      // ownership was released: a later open, once a human has cleared it, works
      for (const key of [...folder.files.keys()].filter((k) => k.startsWith(`${BASE}/import/`) && !k.includes(`/${JOB(1)}/`))) folder.files.delete(key);
      const opened = await FolderVault.openWritable(folder, { anchor: DID });
      expectBytes(await opened.vault.files.read("fine.txt"), utf8("fine"), name);
      expectBytes(folder.files.get(`${BASE}/config.json`), CONFIG, name);
      await opened.close();
    }
  });
});

describe("on disk", () => {
  const made: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-import-"));
    made.push(dir);
    return dir;
  }
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  /** An FsBackend that fails its n-th change and every one after, until revived. */
  class FailingFs extends FsBackend {
    failAt = Infinity;
    count = 0;
    down = false;
    private hit(): void {
      if (this.down) throw new Error("the disk is down");
      this.count += 1;
      if (this.count >= this.failAt) {
        this.down = true;
        throw new Error("the disk is down");
      }
    }
    override async write(p: string, data: Uint8Array): Promise<void> {
      this.hit();
      return super.write(p, data);
    }
    override async create(p: string, source: AsyncIterable<Uint8Array>): Promise<void> {
      this.hit();
      return super.create(p, source);
    }
    override async rename(from: string, to: string): Promise<void> {
      this.hit();
      return super.rename(from, to);
    }
    override async remove(p: string): Promise<void> {
      this.hit();
      return super.remove(p);
    }
  }

  it("imports a folder on disk into a vault on disk, and leaves import/ with no entry, not even an empty directory; a crash between two renames of the publication is finished by the next open, on disk too", async () => {
    const { from } = await source();
    const sourceDir = await tempDir();
    const fromDisk = new FsBackend(sourceDir);
    for (const [key, bytes] of from.files) await fromDisk.write(key, bytes);

    const dir = await tempDir();
    const disk = new FailingFs(dir);
    const vault = await FolderVault.create(disk, { anchor: DID, keystore: KEYSTORE });
    await vault.vault.commit([{ cid: BIG_CID, source: BIG }], [draft([BIG_CID], { mine: true })]);
    const before = ids(await all(vault.vault.events.scan()));
    // the publication moves the object, two segments and one file: fail at the second rename
    disk.count = 0;
    disk.failAt = 1 + 4 + 1 + 2;
    await expect(importFolder(vault, fromDisk, { heldRoots: allRoots })).rejects.toThrow(/the disk is down/);
    expect(vault.open).toBe(false);
    expect((await readdir(path.join(dir, BASE, "import"))).length).toBe(1);
    await expect(FolderReader.open(new FsBackend(dir))).rejects.toThrow(PendingImport);

    const reopened = await FolderVault.openWritable(new FsBackend(dir), { anchor: DID });
    expect(await readdir(path.join(dir, BASE, "import"))).toEqual([]);
    const events = await all(reopened.vault.events.scan());
    expect(events.length).toBe(before.length + 2);
    expectBytes(await reopened.vault.objects.read(HELLO_CID, 1024), HELLO);
    expectBytes(await reopened.vault.files.read("shared/from-source.txt"), utf8("from the source"));
    expect(await reopened.damaged()).toEqual([]);
    expect(await importFolder(reopened, fromDisk, { heldRoots: allRoots })).toEqual({ events: 0, duplicates: 2, conflicts: [], objects: 0, files: 0 });
    expect(await readdir(path.join(dir, BASE, "import"))).toEqual([]);
    await reopened.close();
  });
});
