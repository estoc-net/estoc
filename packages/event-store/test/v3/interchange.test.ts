/**
 * Interchange: a vault in memory or over a folder exported as a portable
 * folder under its writer lock, and a portable folder restored into an
 * empty backend, on the memory backend and on disk.
 */

import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../../src/node.js";
import {
  FolderVault,
  IncompleteSnapshot,
  InvalidSnapshot,
  MemoryBackend,
  MemoryVault,
  NotAVault,
  PendingImport,
  VaultOwned,
  canonicalEventBytes,
  encodeConfig,
  encodeLines,
  exportVault,
  isUuidv7,
  kindOf,
  restoreFolder,
  segmentPath,
  utf8,
  type Cid,
  type Draft,
  type Event,
  type Held,
  type Ownership,
  type VaultBackend,
  type VaultRuntime,
} from "../../src/v3/index.js";
import { all, authorN, clock, expectBytes, ids, uuidv7At } from "./suite/helpers.js";
import { HELLO_CID, cidOf } from "./suite/object-store-suite.js";

const BASE = ".estoc";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const JWE = "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IkFCQ0QifQ.QUJDRA.QUJDRA.QUJDRA.QUJDRA";
const KEYSTORE = utf8(`${JSON.stringify({ version: 3, seedJwe: JWE }, null, 2)}\n`);
const CONFIG = encodeConfig(DID);
const HELLO = new TextEncoder().encode("hello");
const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);
const BIG = new Uint8Array(3 * 64 * 1024 + 7).map((_, i) => i % 251);
const BIG_CID = cidOf(BIG);
const HOUR = 60 * 60 * 1000;
const SEG = (n: number): string => uuidv7At(1_800_000_000_000 + n, 0x5e5e5e00 + n);

const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

/** Every path under `base`, relative to it, sorted. */
function paths(backend: MemoryBackend, base = BASE): string[] {
  return [...backend.files.keys()]
    .filter((p) => p.startsWith(`${base}/`))
    .map((p) => p.slice(base.length + 1))
    .sort();
}

/** A vault in memory that carries its identity, so that it can be exported. */
function memoryVault(options: ConstructorParameters<typeof MemoryVault>[0] = {}): MemoryVault {
  return new MemoryVault({ config: CONFIG, keystore: KEYSTORE, ...options });
}

/** A vault over a fresh memory folder, created and open for writing. */
async function folderVault(backend = new MemoryBackend(), options: Partial<Parameters<typeof FolderVault.create>[1]> = {}): Promise<FolderVault> {
  return FolderVault.create(backend, { anchor: DID, keystore: KEYSTORE, ...options });
}

/** The held roots of every event in the cut: what the fold would say when nothing is erased. */
async function allRoots(held: Held): Promise<Cid[]> {
  const roots: Cid[] = [];
  for await (const event of held.events.scan()) roots.push(...event.roots);
  return roots;
}

/** Two authors' events, two held objects, one orphan and two opaque files in `runtime`, whichever kind it is; the events, in canonical order. */
async function populate(runtime: VaultRuntime, other: MemoryVault): Promise<{ events: Event[]; orphan: Cid }> {
  const { vault } = runtime;
  await vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID], { who: "me" })]);
  await vault.commit([{ cid: BIG_CID, source: BIG }], [draft([BIG_CID], { big: true }), draft([], { second: true })]);
  const [theirs] = await other.vault.commit([], [draft([], { who: "them" })]);
  await runtime.ingest([theirs as Event]);
  await vault.files.write("notes.txt", utf8("hi"));
  await vault.files.write("state/settings.json", utf8("{}"));
  // an object no event names: an orphan under grace, still present
  await vault.commit([{ cid: WORLD_CID, source: WORLD }], []);
  return { events: await all(vault.events.scan()), orphan: WORLD_CID };
}

async function gate(): Promise<{ wait: Promise<void>; open: () => void }> {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

/** A memory backend whose `create` waits at the gate before taking the first object's bytes: an export held mid-copy. */
class GatedBackend extends MemoryBackend {
  gate: Promise<void> | null = null;
  override async create(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.gate !== null) {
      const wait = this.gate;
      this.gate = null;
      await wait;
    }
    return super.create(path, source);
  }
}

/** A destination whose first `own` waits at the gate once asked, so that another laying can fill the folder between an operation's empty check and its ownership; every later `own` is the memory backend's. */
class DelayedOwnership extends MemoryBackend {
  readonly arrived = gate();
  readonly resume = gate();
  private delayed = false;
  override async own(path: string): Promise<Ownership> {
    if (!this.delayed) {
      this.delayed = true;
      (await this.arrived).open();
      await (await this.resume).wait;
    }
    return super.own(path);
  }
}

class RefusingCreate extends MemoryBackend {
  override async create(): Promise<void> {
    throw new Error("the destination cannot create a file");
  }
}

/** A destination whose `create` pulls one chunk and then fails, the source left where it was. */
class PullingOnceCreate extends MemoryBackend {
  override async create(_path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    await source[Symbol.asyncIterator]().next();
    throw new Error("the destination failed after one chunk");
  }
}

/** A source whose `open` counts the streams it hands out and the cancellations they get back. */
class WatchingOpen extends MemoryBackend {
  opened = 0;
  cancelled = 0;
  constructor(from: MemoryBackend) {
    super();
    for (const [key, bytes] of from.files) this.files.set(key, bytes);
  }
  override async open(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.read(path);
    if (bytes === null) return null;
    this.opened += 1;
    let sent = false;
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          if (sent) controller.close();
          else {
            sent = true;
            controller.enqueue(bytes);
          }
        },
        cancel: () => {
          this.cancelled += 1;
        },
      },
      { highWaterMark: 0 }
    );
  }
}

/** A destination whose clock fails once `config.json` has landed: the publication's write rejects with its bytes in place. */
function failingAtPublication(): MemoryBackend {
  const into: MemoryBackend = new MemoryBackend({
    clock: () => {
      if (into.files.has(`${BASE}/config.json`)) throw new Error("the clock failed after the publication landed");
      return new Date();
    },
  });
  return into;
}

/** A destination that cannot take back `config.json` once written, and fails its clock once, as `failingAtPublication` does. */
class KeepingConfig extends MemoryBackend {
  constructor() {
    const laid: { files?: Map<string, Uint8Array>; failed: boolean } = { failed: false };
    super({
      clock: () => {
        if (!laid.failed && laid.files?.has(`${BASE}/config.json`)) {
          laid.failed = true;
          throw new Error("the clock failed after the publication landed");
        }
        return new Date();
      },
    });
    laid.files = this.files;
  }
  override async remove(path: string): Promise<void> {
    if (path === `${BASE}/config.json`) throw new Error("config.json cannot be removed");
    return super.remove(path);
  }
}

describe("laying a vault down", () => {
  it("a publication whose write rejects after its bytes landed is withdrawn first, and only then the rest: the destination is left empty, not a config.json over nothing", async () => {
    const runtime = memoryVault();
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const exportedInto = failingAtPublication();
    await expect(exportVault(runtime, exportedInto, { heldRoots: allRoots })).rejects.toThrow(/after the publication landed/);
    expect(paths(exportedInto)).toEqual([]);
    const from = new MemoryBackend();
    await exportVault(runtime, from, { heldRoots: allRoots });
    const restoredInto = failingAtPublication();
    await expect(restoreFolder(from, restoredInto, { heldRoots: allRoots })).rejects.toThrow(/after the publication landed/);
    expect(paths(restoredInto)).toEqual([]);
    await expect(FolderVault.openWritable(restoredInto, { anchor: DID })).rejects.toThrow(NotAVault);
  });

  it("when the publication cannot be withdrawn, nothing else is taken back either: everything was written before it, so what stands is a complete vault", async () => {
    const runtime = memoryVault();
    const [event] = await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const into = new KeepingConfig();
    await expect(exportVault(runtime, into, { heldRoots: allRoots })).rejects.toThrow(/after the publication landed/);
    expect(paths(into)).toContain("config.json");
    expect(paths(into)).toContain(`objects/${HELLO_CID}`);
    const opened = await FolderVault.openWritable(into, { anchor: DID });
    expect(ids(await all(opened.vault.events.scan()))).toEqual(ids([event as Event]));
    expectBytes(await opened.vault.objects.read(HELLO_CID, 1024), HELLO);
    expect(await opened.damaged()).toEqual([]);
    await opened.close();
  });

  it("a destination another laying filled between the empty check and ownership is refused and left as it stands, every byte, for an export and for a restore", async () => {
    const runtime = memoryVault();
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const from = new MemoryBackend();
    await exportVault(runtime, from, { heldRoots: allRoots });
    const bytesOf = (backend: MemoryBackend): Record<string, number[]> => Object.fromEntries([...backend.files].map(([p, b]) => [p, Array.from(b)]));
    for (const operation of ["export", "restore"] as const) {
      const into = new DelayedOwnership();
      const delayed = operation === "export" ? exportVault(runtime, into, { heldRoots: allRoots }) : restoreFolder(from, into, { heldRoots: allRoots });
      const settled = delayed.then(() => null, (err: unknown) => err);
      await (await into.arrived).wait;
      expect(await restoreFolder(from, into, { heldRoots: allRoots }), operation).toEqual({ events: 1, objects: 1, files: 2 });
      const before = bytesOf(into);
      (await into.resume).open();
      expect(await settled, operation).toBeInstanceOf(NotAVault);
      expect(bytesOf(into), operation).toEqual(before);
      const opened = await FolderVault.openWritable(into, { anchor: DID });
      expect((await all(opened.vault.events.scan())).length, operation).toBe(1);
      expectBytes(await opened.vault.objects.read(HELLO_CID, 1024), HELLO);
      await opened.close();
    }
  });
});

describe("exportVault", () => {
  it("writes a vault in memory as a portable folder that a folder vault opens: every event's canonical bytes, one segment per author, every object, every portable file, and a fresh replica", async () => {
    const other = new MemoryVault();
    const runtime = memoryVault();
    const { events, orphan } = await populate(runtime, other);
    const into = new MemoryBackend();
    const exported = await exportVault(runtime, into, { heldRoots: allRoots });
    expect(exported).toEqual({ events: 4, objects: 3, files: 4, skipped: [] });
    const listed = paths(into);
    expect(listed.filter((p) => kindOf(p) === "local" || kindOf(p) === "import")).toEqual([]);
    expect(listed.filter((p) => kindOf(p) === "damage")).toEqual([]);
    const segments = listed.filter((p) => kindOf(p) === "segment");
    expect(segments.map((p) => p.split("/")[1]).sort()).toEqual([runtime.author, other.author].sort());
    for (const segment of segments) {
      const author = segment.split("/")[1];
      expectBytes(into.files.get(`${BASE}/${segment}`), encodeLines(events.filter((e) => e.author === author)), segment);
      expect(isUuidv7(path.basename(segment, ".jsonl"))).toBe(true);
    }
    expect(listed.filter((p) => kindOf(p) === "object").sort()).toEqual([HELLO_CID, BIG_CID, orphan].map((c) => `objects/${c}`).sort());
    expectBytes(into.files.get(`${BASE}/objects/${BIG_CID}`), BIG);
    expectBytes(into.files.get(`${BASE}/config.json`), CONFIG);
    expectBytes(into.files.get(`${BASE}/keystore.json`), KEYSTORE);
    expectBytes(into.files.get(`${BASE}/notes.txt`), utf8("hi"));
    expectBytes(into.files.get(`${BASE}/state/settings.json`), utf8("{}"));

    const opened = await FolderVault.openWritable(into, { anchor: DID });
    expect(opened.replica.replica_id).not.toBe(runtime.author);
    expect(ids(await all(opened.vault.events.scan()))).toEqual(ids(events));
    expect((await all(opened.vault.events.scan())).map((e) => canonicalEventBytes(e))).toEqual(events.map((e) => canonicalEventBytes(e)));
    expectBytes(await opened.vault.objects.read(HELLO_CID, 1024), HELLO);
    expectBytes(await opened.vault.objects.read(BIG_CID, BIG.length), BIG);
    expect(await opened.vault.files.list()).toEqual(["config.json", "keystore.json", "notes.txt", "state/settings.json"]);
    expect(await opened.damaged()).toEqual([]);
    await opened.close();
  });

  it("a vault over a folder exports the same way, and nothing under local/ travels; two exports of one vault agree on everything but segment names", async () => {
    const other = new MemoryVault();
    const backend = new MemoryBackend();
    const vault = await folderVault(backend);
    const { events } = await populate(vault, other);
    await vault.local("agent").writeOptions({ theme: "dark" });
    expect(paths(backend).some((p) => p.startsWith("local/"))).toBe(true);
    const a = new MemoryBackend();
    const b = new MemoryBackend();
    expect(await exportVault(vault, a, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4, skipped: [] });
    expect(await exportVault(vault, b, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4, skipped: [] });
    await vault.close();
    for (const into of [a, b]) {
      const listed = paths(into);
      expect(listed.some((p) => p.startsWith("local/") || p.startsWith("import/"))).toBe(false);
      expect(listed.filter((p) => kindOf(p) !== "segment")).toEqual(["config.json", "keystore.json", `objects/${BIG_CID}`, `objects/${HELLO_CID}`, `objects/${WORLD_CID}`, "notes.txt", "state/settings.json"].sort());
    }
    const segmentsOf = (into: MemoryBackend): Map<string, Uint8Array> =>
      new Map(paths(into).filter((p) => kindOf(p) === "segment").map((p) => [p.split("/")[1] as string, into.files.get(`${BASE}/${p}`) as Uint8Array]));
    const sa = segmentsOf(a);
    const sb = segmentsOf(b);
    expect([...sa.keys()].sort()).toEqual([...sb.keys()].sort());
    for (const [author, bytes] of sa) {
      expectBytes(sb.get(author), bytes, author);
      expectBytes(bytes, encodeLines(events.filter((e) => e.author === author)), author);
    }
    expect(paths(a).filter((p) => kindOf(p) === "segment")).not.toEqual(paths(b).filter((p) => kindOf(p) === "segment"));
  });

  it("holds the writer lock from selecting the cut through copying and publication: the held roots are computed inside it, and a commit, a file write and a collection pass wait for it", async () => {
    const t = clock("2026-09-08T10:00:00.000Z");
    const runtime = memoryVault({ now: t.now, graceMs: HOUR });
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    // an orphan, old enough to collect
    await runtime.vault.commit([{ cid: WORLD_CID, source: WORLD }], []);
    t.advance(2 * HOUR);
    const into = new GatedBackend();
    const g = await gate();
    into.gate = g.wait;
    let insideLock = false;
    const exporting = exportVault(runtime, into, {
      heldRoots: async (held) => {
        insideLock = runtime.lock.held;
        return allRoots(held);
      },
    });
    await tick();
    expect(insideLock).toBe(true);
    const order: string[] = [];
    const collecting = runtime.collect(allRoots).then((c) => order.push(`collect ${c.unlinked.length}`));
    const committing = runtime.vault.commit([], [draft([], { late: true })]).then(() => order.push("commit"));
    const writing = runtime.vault.files.write("late.txt", utf8("late")).then(() => order.push("write"));
    await tick();
    expect(order).toEqual([]);
    expect(paths(into)).not.toContain("config.json");
    g.open();
    const exported = await exporting;
    order.push("export");
    await Promise.all([collecting, committing, writing]);
    expect(order).toEqual(["export", "collect 1", "commit", "write"]);
    // the cut is what stood when the export began: both objects, one event, no late.txt
    expect(exported).toEqual({ events: 1, objects: 2, files: 2, skipped: [] });
    expect(paths(into)).toContain(`objects/${WORLD_CID}`);
    expect(paths(into)).not.toContain("late.txt");
    expect(await runtime.vault.objects.has(WORLD_CID)).toBe(false);
  });

  it("aborts unpublished — no config.json, and what was written taken back — when a held root is not present or its bytes are damaged; an orphan found damaged is skipped and reported", async () => {
    const runtime = memoryVault();
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await runtime.vault.commit([{ cid: WORLD_CID, source: WORLD }], []);
    await runtime.vault.files.write("notes.txt", utf8("hi"));
    const missing = new MemoryBackend();
    await expect(exportVault(runtime, missing, { heldRoots: () => [HELLO_CID, BIG_CID] })).rejects.toThrow(IncompleteSnapshot);
    await expect(exportVault(runtime, missing, { heldRoots: () => [BIG_CID] })).rejects.toMatchObject({ problems: [{ where: `objects/${BIG_CID}`, error: "a held root is not present" }] });
    expect(paths(missing)).toEqual([]);

    runtime.stores.objects.damage(WORLD_CID);
    const orphanDamaged = new MemoryBackend();
    const exported = await exportVault(runtime, orphanDamaged, { heldRoots: allRoots });
    expect(exported.objects).toBe(1);
    expect(exported.skipped).toEqual([{ where: `objects/${WORLD_CID}`, error: expect.stringMatching(/no longer hash/) }]);
    expect(paths(orphanDamaged)).toContain("config.json");
    expect(paths(orphanDamaged)).not.toContain(`objects/${WORLD_CID}`);

    runtime.stores.objects.damage(HELLO_CID);
    const rootDamaged = new MemoryBackend();
    await expect(exportVault(runtime, rootDamaged, { heldRoots: allRoots })).rejects.toThrow(IncompleteSnapshot);
    expect(paths(rootDamaged)).toEqual([]);
    // the lock is free again after an abort
    await runtime.vault.commit([], [draft()]);
  });

  it("aborts on damage or a conflict in the event set, since that is not a consistent cut; refuses a destination that is not empty, or is a file; and a vault in memory with no identity has nothing to export", async () => {
    const backend = new MemoryBackend();
    const vault = await folderVault(backend);
    const [mine] = await vault.vault.commit([], [draft()]);
    await backend.write(`${BASE}/events/${authorN(1)}/stray.txt`, utf8("x"));
    await expect(exportVault(vault, new MemoryBackend(), { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: `events/${authorN(1)}/stray.txt` }] });
    await backend.remove(`${BASE}/events/${authorN(1)}/stray.txt`);
    const twisted = { ...(mine as Event), data: { n: 2 } };
    await backend.write(`${BASE}/${segmentPath(vault.author, SEG(1))}`, encodeLines([twisted]));
    await expect(exportVault(vault, new MemoryBackend(), { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: `events:${mine?.eventId}` }] });
    await backend.remove(`${BASE}/${segmentPath(vault.author, SEG(1))}`);

    const taken = new MemoryBackend();
    await taken.write(`${BASE}/notes.txt`, utf8("x"));
    await expect(exportVault(vault, taken, { heldRoots: allRoots })).rejects.toThrow(NotAVault);
    expect(paths(taken)).toEqual(["notes.txt"]);
    const file = new MemoryBackend();
    await file.write(BASE, utf8("x"));
    await expect(exportVault(vault, file, { heldRoots: allRoots })).rejects.toThrow(NotAVault);
    const owned = new MemoryBackend();
    const holder = await owned.own(`${BASE}/local/owner.pid`);
    await expect(exportVault(vault, owned, { heldRoots: allRoots })).rejects.toThrow(VaultOwned);
    await holder.release();
    expect(await exportVault(vault, owned, { heldRoots: allRoots })).toMatchObject({ events: 1 });
    await vault.close();

    await expect(exportVault(new MemoryVault(), new MemoryBackend(), { heldRoots: () => [] })).rejects.toThrow(/no config.json/);
  });

  it("checks config.json and keystore.json as a restore would before writing anything: a vault with no keystore, a config of another shape or a keystore of another shape is refused, since what it published would not restore", async () => {
    const cases: [string, ConstructorParameters<typeof MemoryVault>[0], RegExp][] = [
      ["no keystore", { config: CONFIG }, /no keystore.json/],
      ["a config of another shape", { config: utf8("{}"), keystore: KEYSTORE }, /config.json: format/],
      ["a keystore of another shape", { config: CONFIG, keystore: utf8("{}") }, /keystore.json has no/],
    ];
    for (const [name, options, error] of cases) {
      const runtime = new MemoryVault(options);
      await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const into = new MemoryBackend();
      await expect(exportVault(runtime, into, { heldRoots: allRoots }), name).rejects.toThrow(NotAVault);
      await expect(exportVault(runtime, into, { heldRoots: allRoots }), name).rejects.toThrow(error);
      expect(paths(into), name).toEqual([]);
    }
  });

  it("ends the object stream it opened when the destination fails before pulling from it, or midway: the latch is released and the object collectable, nothing held", async () => {
    const runtime = memoryVault({ graceMs: 0 });
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], []);
    for (const into of [new RefusingCreate(), new PullingOnceCreate()]) {
      await expect(exportVault(runtime, into, { heldRoots: allRoots })).rejects.toThrow(/the destination/);
      expect(runtime.latches.count(HELLO_CID)).toBe(0);
      expect(paths(into)).toEqual([]);
    }
    expect((await runtime.collect(() => [])).unlinked).toEqual([HELLO_CID]);
    expect(await runtime.vault.objects.has(HELLO_CID)).toBe(false);
  });
});

describe("restoreFolder", () => {
  /** An exported folder in memory, from a populated vault; and the events it holds. */
  async function exported(): Promise<{ from: MemoryBackend; events: Event[] }> {
    const other = new MemoryVault();
    const runtime = memoryVault();
    const { events } = await populate(runtime, other);
    const from = new MemoryBackend();
    await exportVault(runtime, from, { heldRoots: allRoots });
    return { from, events };
  }

  it("copies every portable byte of a valid snapshot into an empty backend, config.json last, and the result opens as a new replica with the same events, objects and files", async () => {
    const { from, events } = await exported();
    const into = new MemoryBackend();
    expect(await restoreFolder(from, into, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4 });
    expect(paths(into)).toEqual(paths(from));
    for (const rel of paths(from)) expectBytes(into.files.get(`${BASE}/${rel}`), from.files.get(`${BASE}/${rel}`) as Uint8Array, rel);
    const opened = await FolderVault.openWritable(into, { anchor: DID });
    expect(isUuidv7(opened.replica.replica_id)).toBe(true);
    expect(paths(from)).not.toContain("local/replica.json");
    expect((await all(opened.vault.events.scan())).map((e) => canonicalEventBytes(e))).toEqual(events.map((e) => canonicalEventBytes(e)));
    expectBytes(await opened.vault.objects.read(BIG_CID, BIG.length), BIG);
    expect(await opened.vault.files.list()).toEqual(["config.json", "keystore.json", "notes.txt", "state/settings.json"]);
    expect(await opened.damaged()).toEqual([]);
    // exported again from the restored copy: the same portable bytes, the same event set
    const again = new MemoryBackend();
    await exportVault(opened, again, { heldRoots: allRoots });
    await opened.close();
    expect(paths(again).filter((p) => kindOf(p) !== "segment")).toEqual(paths(from).filter((p) => kindOf(p) !== "segment"));
    for (const rel of paths(from).filter((p) => kindOf(p) !== "segment")) expectBytes(again.files.get(`${BASE}/${rel}`), from.files.get(`${BASE}/${rel}`) as Uint8Array, rel);
  });

  /** `backend` with every `read` and `open` recorded in `reads`. */
  function watching(backend: MemoryBackend, reads: string[]): VaultBackend {
    return new Proxy(backend, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "read" || prop === "open") {
          return (p: string) => {
            reads.push(p);
            return (value as (p: string) => unknown).call(target, p);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("never copies the source's local/ — a replica file, an owner's options — and never reads it", async () => {
    const { from } = await exported();
    await from.write(`${BASE}/local/replica.json`, utf8(`{"replica_id":"${authorN(1)}","store_generation":"${authorN(2)}"}`));
    await from.write(`${BASE}/local/agent/options.json`, utf8("{}"));
    const reads: string[] = [];
    const into = new MemoryBackend();
    expect(await restoreFolder(watching(from, reads), into, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4 });
    expect(paths(into).some((p) => p.startsWith("local/"))).toBe(false);
    expect(reads.some((p) => p.includes("/local/"))).toBe(false);
    const opened = await FolderVault.openWritable(into, { anchor: DID });
    expect(opened.replica.replica_id).not.toBe(authorN(1));
    await opened.close();
  });

  it("refuses a source with anything under import/ — a journal it does not know, one left mid-publication, staging alone — without reading it or writing anything: what the source's owner has not finished is not a snapshot", async () => {
    const half = new Uint8Array([1, 2, 3]);
    const cases: [string, (from: MemoryBackend) => Promise<void>][] = [
      ["an unknown journal", (from) => from.write(`${BASE}/import/${SEG(1)}/journal.json`, utf8('{"do":"harm"}'))],
      ["a journal left mid-publication", (from) => from.write(`${BASE}/import/pending/journal.json`, utf8('{"state":"publishing"}'))],
      ["staging alone", (from) => from.write(`${BASE}/import/${SEG(1)}/staged/objects/${WORLD_CID}`, half)],
    ];
    for (const [name, twist] of cases) {
      const { from } = await exported();
      await twist(from);
      await expect(FolderVault.openWritable(from, { anchor: DID }), name).rejects.toThrow(PendingImport);
      const reads: string[] = [];
      const into = new MemoryBackend();
      await expect(restoreFolder(watching(from, reads), into, { heldRoots: allRoots }), name).rejects.toThrow(PendingImport);
      expect(paths(into), name).toEqual([]);
      expect(reads.some((p) => p.includes("/import/")), name).toBe(false);
      await expect(FolderVault.openWritable(into, { anchor: DID }), name).rejects.toThrow(NotAVault);
    }
  });

  /** A fold for these tests: an event's roots are held unless a `test.release` event names that event in `data.of`; another event naming the same root keeps it. */
  async function retained(held: Held): Promise<Cid[]> {
    const events = await all(held.events.scan());
    const released = new Set(events.filter((e) => e.type === "test.release").map((e) => (e.data as { of: string }).of));
    return events.filter((e) => !released.has(e.eventId)).flatMap((e) => e.roots);
  }

  it("requires every held root of the source's event set, as the fold computes it, to be among the source's objects: a missing root of an event of unknown type, or one another event still holds, refuses the source with nothing written; a root the fold has released may be gone", async () => {
    const source = async (drafts: (roots: Draft[]) => Draft[]): Promise<MemoryBackend> => {
      const runtime = memoryVault();
      const held = await runtime.vault.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: WORLD },
        ],
        [{ type: "future.retained", roots: [HELLO_CID], data: {} }, draft([WORLD_CID])]
      );
      await runtime.vault.commit([], drafts(held));
      const from = new MemoryBackend();
      await exportVault(runtime, from, { heldRoots: retained });
      return from;
    };

    const unknown = await source(() => []);
    await dropObject(unknown, HELLO_CID);
    const into = new MemoryBackend();
    await expect(restoreFolder(unknown, into, { heldRoots: retained })).rejects.toMatchObject({ problems: [{ where: `objects/${HELLO_CID}`, error: "a held root is not present" }] });
    expect(paths(into)).toEqual([]);

    const released = await source(([, world]) => [{ type: "test.release", roots: [], data: { of: (world as Event).eventId } }]);
    await dropObject(released, WORLD_CID);
    const restored = new MemoryBackend();
    expect(await restoreFolder(released, restored, { heldRoots: retained })).toEqual({ events: 3, objects: 1, files: 2 });
    expect(paths(restored)).toContain(`objects/${HELLO_CID}`);
    expect(paths(restored)).not.toContain(`objects/${WORLD_CID}`);

    const stillHeld = await source(([, world]) => [{ type: "test.release", roots: [], data: { of: (world as Event).eventId } }, draft([WORLD_CID], { again: true })]);
    await dropObject(stillHeld, WORLD_CID);
    const refused = new MemoryBackend();
    await expect(restoreFolder(stillHeld, refused, { heldRoots: retained })).rejects.toMatchObject({ problems: [{ where: `objects/${WORLD_CID}`, error: "a held root is not present" }] });
    expect(paths(refused)).toEqual([]);
  });

  async function dropObject(from: MemoryBackend, cid: Cid): Promise<void> {
    await from.remove(`${BASE}/objects/${cid}`);
    expect(paths(from)).not.toContain(`objects/${cid}`);
  }

  it("cancels the source stream it opened when the destination fails before pulling from it, and when the copy fails midway", async () => {
    const { from } = await exported();
    const watched = new WatchingOpen(from);
    await expect(restoreFolder(watched, new RefusingCreate(), { heldRoots: allRoots })).rejects.toThrow(/cannot create/);
    expect(watched.opened).toBe(1);
    expect(watched.cancelled).toBe(1);
    const midway = new WatchingOpen(from);
    await expect(restoreFolder(midway, new PullingOnceCreate(), { heldRoots: allRoots })).rejects.toThrow(/after one chunk/);
    expect(midway.opened).toBe(1);
    expect(midway.cancelled).toBe(1);
  });

  it("refuses what is not a valid snapshot before writing anything: no config, another version, no or malformed keystore, an entry inside a structural root, a misfiled or non-canonical line, a fragment, a conflict", async () => {
    const empty = new MemoryBackend();
    await expect(restoreFolder(empty, new MemoryBackend(), { heldRoots: allRoots })).rejects.toThrow(NotAVault);
    const v2 = new MemoryBackend();
    await v2.write(`${BASE}/config.json`, utf8(JSON.stringify({ format: "estoc", version: 2, identity: { anchor: { did: DID, key: "x" } } })));
    await expect(restoreFolder(v2, new MemoryBackend(), { heldRoots: allRoots })).rejects.toThrow(/version/);

    const cases: [string, (from: MemoryBackend) => Promise<void>, string][] = [
      ["no keystore", async (from) => from.remove(`${BASE}/keystore.json`), "keystore.json"],
      ["a keystore of another shape", async (from) => from.write(`${BASE}/keystore.json`, utf8('{"version":3,"keys":[]}')), "keystore.json"],
      ["a stray file under objects/", async (from) => from.write(`${BASE}/objects/notacid`, utf8("x")), "objects/notacid"],
      ["a stray file under events/", async (from) => from.write(`${BASE}/events/${authorN(1)}/notes.txt`, utf8("x")), `events/${authorN(1)}/notes.txt`],
      [
        "a line under another author's directory",
        async (from) => {
          const line = paths(from).find((p) => kindOf(p) === "segment") as string;
          const bytes = from.files.get(`${BASE}/${line}`) as Uint8Array;
          await from.write(`${BASE}/${segmentPath(authorN(7), SEG(2))}`, bytes);
        },
        `events/${authorN(7)}/${SEG(2)}.jsonl:1`,
      ],
      [
        "a compact but non-canonical line",
        async (from) => {
          const line = paths(from).find((p) => kindOf(p) === "segment") as string;
          const text = new TextDecoder().decode(from.files.get(`${BASE}/${line}`) as Uint8Array).split("\n")[0] as string;
          const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(text)).reverse()));
          await from.write(`${BASE}/${line.split("/").slice(0, 2).join("/")}/${SEG(3)}.jsonl`, utf8(`${reordered}\n`));
        },
        `:1`,
      ],
      [
        "a fragment",
        async (from) => {
          const line = paths(from).find((p) => kindOf(p) === "segment") as string;
          await from.write(`${BASE}/${line.split("/").slice(0, 2).join("/")}/${SEG(4)}.jsonl`, utf8('{"at":"2026-'));
        },
        `${SEG(4)}.jsonl:1`,
      ],
      [
        "the same eventId with other bytes",
        async (from) => {
          const line = paths(from).find((p) => kindOf(p) === "segment") as string;
          const text = new TextDecoder().decode(from.files.get(`${BASE}/${line}`) as Uint8Array).split("\n")[0] as string;
          const event = JSON.parse(text) as Event;
          await from.write(`${BASE}/${line.split("/").slice(0, 2).join("/")}/${SEG(5)}.jsonl`, encodeLines([{ ...event, data: { n: 99 } }]));
        },
        "again with different canonical bytes",
      ],
    ];
    for (const [name, twist, where] of cases) {
      const { from } = await exported();
      await twist(from);
      const into = new MemoryBackend();
      const err = await restoreFolder(from, into, { heldRoots: allRoots }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(InvalidSnapshot);
      expect(`${(err as InvalidSnapshot).problems.map((p) => `${p.where}: ${p.error}`).join("\n")}`, name).toContain(where);
      expect(paths(into), name).toEqual([]);
    }
  });

  it("an object whose bytes do not hash to its name is refused as it is copied, and the destination is taken back to empty with no config.json", async () => {
    const { from } = await exported();
    await from.write(`${BASE}/objects/${HELLO_CID}`, WORLD);
    const into = new MemoryBackend();
    await expect(restoreFolder(from, into, { heldRoots: allRoots })).rejects.toMatchObject({ problems: [{ where: `objects/${HELLO_CID}`, error: "the bytes do not hash to the name" }] });
    expect(paths(into)).toEqual([]);
    await expect(FolderVault.openWritable(into, { anchor: DID })).rejects.toThrow(NotAVault);
  });

  it("refuses a destination that is not empty, or owned by another, writing nothing; a source with an unknown portable directory tree round-trips it", async () => {
    const { from } = await exported();
    await from.write(`${BASE}/attachments/2026/a.bin`, BIG);
    const taken = new MemoryBackend();
    await taken.write(`${BASE}/local/agent/options.json`, utf8("{}"));
    await expect(restoreFolder(from, taken, { heldRoots: allRoots })).rejects.toThrow(NotAVault);
    expect(paths(taken)).toEqual(["local/agent/options.json"]);
    const owned = new MemoryBackend();
    const holder = await owned.own(`${BASE}/local/owner.pid`);
    await expect(restoreFolder(from, owned, { heldRoots: allRoots })).rejects.toThrow(VaultOwned);
    await holder.release();
    expect(await restoreFolder(from, owned, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 5 });
    expectBytes(owned.files.get(`${BASE}/attachments/2026/a.bin`), BIG);
  });

  it("reads the source's layout from another directory and lays the destination's down in another", async () => {
    const other = new MemoryVault();
    const runtime = memoryVault();
    await populate(runtime, other);
    const from = new MemoryBackend();
    await exportVault(runtime, from, { heldRoots: allRoots, base: "vault-a" });
    expect(paths(from, "vault-a")).toContain("config.json");
    const into = new MemoryBackend();
    await restoreFolder(from, into, { heldRoots: allRoots, fromBase: "vault-a", base: "vault-b" });
    expect(paths(into, "vault-b")).toEqual(paths(from, "vault-a"));
    const opened = await FolderVault.openWritable(into, { anchor: DID, base: "vault-b" });
    expect((await all(opened.vault.events.scan())).length).toBe(4);
    await opened.close();
  });
});

describe("on disk", () => {
  const made: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-interchange-"));
    made.push(dir);
    return dir;
  }
  afterAll(async () => {
    for (const dir of made) await rm(dir, { recursive: true, force: true });
  });

  it("a folder vault on disk exports to a directory, which restores to a third, which opens with the same events and objects; the destinations hold no owner file after", async () => {
    const source = new FsBackend(await tempDir());
    const vault = await FolderVault.create(source, { anchor: DID, keystore: KEYSTORE });
    const { events } = await populate(vault, new MemoryVault());
    await vault.local("agent").writeOptions({ theme: "dark" });
    const exportedDir = await tempDir();
    const into = new FsBackend(exportedDir);
    expect(await exportVault(vault, into, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4, skipped: [] });
    await vault.close();
    expect(await readdir(path.join(exportedDir, BASE, "local")).catch(() => [])).toEqual([]);
    const restoredDir = await tempDir();
    const third = new FsBackend(restoredDir);
    expect(await restoreFolder(into, third, { heldRoots: allRoots })).toEqual({ events: 4, objects: 3, files: 4 });
    expect(await readdir(path.join(restoredDir, BASE, "local")).catch(() => [])).toEqual([]);
    const opened = await FolderVault.openWritable(third, { anchor: DID });
    expect((await all(opened.vault.events.scan())).map((e) => canonicalEventBytes(e))).toEqual(events.map((e) => canonicalEventBytes(e)));
    expectBytes(await opened.vault.objects.read(BIG_CID, BIG.length), BIG);
    expect(await opened.vault.files.list()).toEqual(["config.json", "keystore.json", "notes.txt", "state/settings.json"]);
    await opened.close();
  });

  it("refuses a source with a directory the layout does not define in a structural root, an empty one included — which a walk of the files alone would pass over — with nothing written", async () => {
    const dir = await tempDir();
    const from = new FsBackend(dir);
    await from.write(`${BASE}/config.json`, CONFIG);
    await from.write(`${BASE}/keystore.json`, KEYSTORE);
    await mkdir(path.join(dir, BASE, "events", "not-an-author"), { recursive: true });
    await mkdir(path.join(dir, BASE, "events", authorN(1), "nested"), { recursive: true });
    await mkdir(path.join(dir, BASE, "objects", "not-an-object"), { recursive: true });
    const into = new MemoryBackend();
    const err = await restoreFolder(from, into, { heldRoots: allRoots }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSnapshot);
    expect((err as InvalidSnapshot).problems.map((p) => p.where)).toEqual([`events/${authorN(1)}/nested`, "events/not-an-author", "objects/not-an-object"]);
    expect(paths(into)).toEqual([]);
  });

  it("a restore that fails on disk leaves no config.json behind", async () => {
    const runtime = memoryVault();
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const from = new MemoryBackend();
    await exportVault(runtime, from, { heldRoots: allRoots });
    await from.write(`${BASE}/objects/${HELLO_CID}`, WORLD);
    const dir = await tempDir();
    const into: VaultBackend = new FsBackend(dir);
    await expect(restoreFolder(from, into, { heldRoots: allRoots })).rejects.toThrow(InvalidSnapshot);
    expect(await into.read(`${BASE}/config.json`)).toBeNull();
    expect(await into.read(`${BASE}/keystore.json`)).toBeNull();
    expect(await into.read(`${BASE}/objects/${HELLO_CID}`)).toBeNull();
  });
});
