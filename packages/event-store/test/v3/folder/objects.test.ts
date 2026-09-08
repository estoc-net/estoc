import { mkdtemp, open as fsOpen, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../../../src/node.js";
import {
  ACCEPTED_DIR,
  DAMAGED_DIR,
  DamagedLayout,
  DamagedObject,
  DigestMismatch,
  FolderObjectStore,
  MemoryBackend,
  ObjectTooLarge,
  STAGING_DIR,
  chunksOf,
  objectPath,
  type Cid,
  type VaultBackend,
} from "../../../src/v3/index.js";
import { all, clock, expectBytes } from "../suite/helpers.js";
import { BAD_CIDS, HELLO_CID, bytesOf, chunked, cidOf, drain, objectStoreSuite, type OpenObjectOptions } from "../suite/object-store-suite.js";

const T0 = "2026-09-07T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;
const BASE = ".estoc";
const HELLO = new TextEncoder().encode("hello");

/** The suite's options as a store takes them: `extentBytes` is nobody's here — a folder has no extents. */
function storeOptions(options: OpenObjectOptions): ConstructorParameters<typeof FolderObjectStore>[1] {
  return {
    base: BASE,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
    ...(options.latches === undefined ? {} : { latches: options.latches }),
  };
}

/** The backend's clock, the suite's when it pins one: an object's age is its file's modification time against the store's `now`. */
function clockOf(options: OpenObjectOptions): () => Date {
  return () => new Date(options.now === undefined ? Date.now() : options.now());
}

objectStoreSuite("FolderObjectStore over MemoryBackend", async (options = {}) => {
  const backend = new MemoryBackend({ clock: clockOf(options) });
  return {
    store: new FolderObjectStore(backend, storeOptions(options)),
    corrupt: async (cid) => {
      const bytes = backend.files.get(`${BASE}/${objectPath(cid)}`) as Uint8Array;
      bytes[0] = (bytes[0] as number) ^ 0x01; // in place: the map's own bytes, no write the backend sees
    },
  };
});

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-objects-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A byte of the file at `objects/<cid>` flipped on disk, behind the backend's back, as a bad sector would. */
async function corruptOnDisk(root: string, cid: Cid): Promise<void> {
  const file = path.join(root, BASE, "objects", cid);
  const bytes = new Uint8Array(await readFile(file));
  bytes[0] = (bytes[0] as number) ^ 0x01;
  await writeFile(file, bytes);
}

objectStoreSuite("FolderObjectStore over FsBackend", async (options = {}) => {
  const root = await tempDir();
  const backend = new FsBackend(root, { clock: clockOf(options) });
  return {
    store: new FolderObjectStore(backend, storeOptions(options)),
    corrupt: (cid) => corruptOnDisk(root, cid),
  };
});

// ---- the folder itself ------------------------------------------------------

type Fresh = () => Promise<{ backend: VaultBackend; store: FolderObjectStore; reopen: (options?: OpenObjectOptions) => FolderObjectStore; root?: string }>;

function overMemory(options: OpenObjectOptions = {}): ReturnType<Fresh> {
  const backend = new MemoryBackend({ clock: clockOf(options) });
  const reopen = (more: OpenObjectOptions = {}): FolderObjectStore => new FolderObjectStore(backend, storeOptions({ ...options, ...more }));
  return Promise.resolve({ backend, store: reopen(), reopen });
}

async function overDisk(options: OpenObjectOptions = {}): ReturnType<Fresh> {
  const root = await tempDir();
  const backend = new FsBackend(root, { clock: clockOf(options) });
  const reopen = (more: OpenObjectOptions = {}): FolderObjectStore => new FolderObjectStore(backend, storeOptions({ ...options, ...more }));
  return { backend, store: reopen(), reopen, root };
}

async function fileAt(backend: VaultBackend, rel: string): Promise<Uint8Array | null> {
  return backend.read(`${BASE}/${rel}`);
}

async function namesUnder(backend: VaultBackend, rel: string): Promise<string[]> {
  return (await backend.list(`${BASE}/${rel}`)).sort();
}

for (const [name, fresh] of [
  ["over MemoryBackend", overMemory],
  ["over FsBackend", overDisk],
] as const) {
 describe(`FolderObjectStore ${name}`, () => {
    it("an accepted object is one file, objects/<cid>, holding exactly its bytes — nothing else under objects/, nothing left in staging", async () => {
      const { backend, store } = await fresh();
      const bytes = bytesOf(300 * 1024 + 11, 1);
      const cid = (await store.putRaw(chunked(bytes, [100_000, 100_000, 100_000]))).cid;
      expect(cid).toBe(cidOf(bytes));
      expectBytes(await fileAt(backend, objectPath(cid)), bytes);
      expect(await namesUnder(backend, "objects")).toEqual([cid]);
      expect(await backend.dirs(`${BASE}/objects`)).toEqual([]);
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
      const other = (await store.putObject(HELLO_CID, HELLO)).cid;
      expectBytes(await fileAt(backend, objectPath(other)), HELLO);
      expect(await namesUnder(backend, "objects")).toEqual([cid, HELLO_CID].sort());
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
    });

    it("a second store over the same folder finds the object, by presence, by stat, by list, by open — the bytes and the CID the same", async () => {
      const { store, reopen } = await fresh();
      const bytes = bytesOf(50_000, 2);
      const cid = (await store.putRaw(bytes)).cid;
      const again = reopen();
      expect(await again.has(cid)).toBe(true);
      expect(await again.stat(cid)).toEqual({ cid, codec: "raw", size: bytes.length });
      expect(await all(again.list())).toEqual([cid]);
      expectBytes((await drain((await again.open(cid)) as ReadableStream<Uint8Array>)).bytes, bytes);
      expectBytes(await again.read(cid, bytes.length), bytes);
    });

    it("a refused put — a mismatch, an oversize source, a source that throws — leaves nothing in objects/ and nothing in staging", async () => {
      const { backend, store } = await fresh({ maxObjectBytes: 10_000 });
      const bytes = bytesOf(5_000, 3);
      await expect(store.putObject(cidOf(bytes), bytesOf(5_000, 4))).rejects.toThrow(DigestMismatch);
      await expect(store.putRaw(bytesOf(10_001, 5))).rejects.toThrow(ObjectTooLarge);
      async function* failing(): AsyncIterable<Uint8Array> {
        yield bytes.slice(0, 100);
        throw new Error("source gone");
      }
      await expect(store.putRaw(failing())).rejects.toThrow("source gone");
      expect(await namesUnder(backend, "objects")).toEqual([]);
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
      expect(await all(store.list())).toEqual([]);
    });

    it("a staging file a crash left is not an object and is swept by collect once past grace; one being written is not", async () => {
      const c = clock(T0);
      const { backend, store } = await fresh({ now: c.now, graceMs: HOUR });
      await backend.write(`${BASE}/${STAGING_DIR}/019b0000-0000-7000-8000-000000000001`, bytesOf(100, 6)); // as a crash mid-put would leave it
      expect(await all(store.list())).toEqual([]);
      expect(await store.damaged()).toEqual([]);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
      expect(await namesUnder(backend, STAGING_DIR)).toHaveLength(1); // within grace
      c.advance(HOUR);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
      // A put whose source waits, mid-stream, while a collection pass runs: its staging file, whatever its age, stays.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* slow(): AsyncIterable<Uint8Array> {
        yield bytesOf(10, 7);
        await gate;
        yield bytesOf(10, 8);
      }
      const put = store.putRaw(slow());
      await new Promise((resolve) => setTimeout(resolve, 20));
      c.advance(100 * HOUR);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
      release();
      const info = await put;
      expect(info.size).toBe(20);
      expect(await store.has(info.cid)).toBe(true);
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
    });

    it("a file whose bytes do not spell its name reads as present until looked at; the stream then fails, the file goes to local/damaged/objects/, and presence is gone", async () => {
      const { backend, store } = await fresh();
      const bytes = bytesOf(2_000, 9);
      const cid = (await store.putRaw(bytes)).cid;
      const wrong = bytesOf(2_000, 10);
      await backend.write(`${BASE}/${objectPath(cid)}`, wrong); // a hand-copied file under a name it does not spell
      expect(await store.has(cid)).toBe(true);
      expect(await store.damaged()).toEqual([]); // a walk does not read bytes
      let failed: unknown;
      try {
        for await (const _ of chunksOf((await store.open(cid)) as ReadableStream<Uint8Array>)) {
          // consumed and discarded
        }
      } catch (err) {
        failed = err;
      }
      expect(failed).toBeInstanceOf(DamagedObject);
      expect(await store.has(cid)).toBe(false);
      expect(await namesUnder(backend, "objects")).toEqual([]);
      expectBytes(await fileAt(backend, `${DAMAGED_DIR}/${cid}`), wrong);
      // Again, under the same name: the second goes aside under a numbered suffix, the first stays what it was.
      await backend.write(`${BASE}/${objectPath(cid)}`, bytesOf(2_000, 11));
      await expect(store.read(cid, 2_000)).rejects.toThrow(DamagedObject);
      expect(await namesUnder(backend, DAMAGED_DIR)).toEqual([cid, `${cid}.1`]);
      expectBytes(await fileAt(backend, `${DAMAGED_DIR}/${cid}`), wrong);
      expectBytes(await fileAt(backend, `${DAMAGED_DIR}/${cid}.1`), bytesOf(2_000, 11));
    });

    it("a put that heals a damaged object while a stream over the old bytes is still open is not undone by that stream's failure", async () => {
      const c = clock(T0);
      const { backend, store } = await fresh({ now: c.now });
      const bytes = bytesOf(1_000, 12);
      const cid = (await store.putRaw(bytes)).cid;
      await backend.write(`${BASE}/${objectPath(cid)}`, bytesOf(1_000, 13));
      const stale = (await store.open(cid)) as ReadableStream<Uint8Array>; // opened on the damaged file
      c.advance(1);
      await store.putObject(cid, bytes); // healed underneath it
      let failed: unknown;
      try {
        await drain(stale);
      } catch (err) {
        failed = err;
      }
      // The stale stream may fail — its bytes were the damaged file's — or, on a backend whose open reads the file as it is now, complete; either way the healed object stands.
      if (failed !== undefined) expect(failed).toBeInstanceOf(DamagedObject);
      expect(await store.has(cid)).toBe(true);
      expectBytes(await store.read(cid, 1_000), bytes);
      expect(await namesUnder(backend, DAMAGED_DIR)).toEqual([]);
    });

    it("a heal of the same length in the same clock tick, under a stream opened on the damaged bytes, stands — the stale stream may fail, the healed object is not moved aside", async () => {
      const c = clock(T0);
      const { backend, store } = await fresh({ now: c.now });
      const cid = (await store.putRaw(HELLO)).cid;
      await backend.write(`${BASE}/${objectPath(cid)}`, new TextEncoder().encode("jello")); // same length, wrong bytes
      const stale = (await store.open(cid)) as ReadableStream<Uint8Array>;
      await store.putObject(cid, HELLO); // healed: same size, same clock reading
      let failed: unknown;
      try {
        await drain(stale);
      } catch (err) {
        failed = err;
      }
      if (failed !== undefined) expect(failed).toBeInstanceOf(DamagedObject);
      expect(await store.has(cid)).toBe(true);
      expectBytes(await store.read(cid, 5), HELLO);
      expect(await namesUnder(backend, DAMAGED_DIR)).toEqual([]);
      expect(await namesUnder(backend, "objects")).toEqual([cid]);
    });

    it("an object's age counts from its acceptance, recorded as local/accepted/objects/<cid>: written with the move, renewed by a repeat, removed with the object or when the object is gone; an object with no stamp is stamped and young", async () => {
      const c = clock(T0);
      const { backend, store, reopen } = await fresh({ now: c.now, graceMs: HOUR });
      const cid = (await store.putRaw(bytesOf(10, 30))).cid;
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([cid]);
      expect(await backend.modified(`${BASE}/${ACCEPTED_DIR}/${cid}`)).toBe(c.now());
      c.advance(HOUR - 1);
      await store.putObject(cid, bytesOf(10, 30));
      expect(await backend.modified(`${BASE}/${ACCEPTED_DIR}/${cid}`)).toBe(c.now()); // renewed
      c.advance(HOUR - 1);
      expect(await reopen().collect([])).toEqual({ unlinked: [], young: [cid] });
      c.advance(1);
      expect(await reopen().collect([])).toEqual({ unlinked: [cid], young: [] });
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([]); // the stamp went with the object
      // A stamp with no object — a crash between the stamp and the move — goes at the next pass.
      await backend.write(`${BASE}/${ACCEPTED_DIR}/${HELLO_CID}`, new Uint8Array(0));
      expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([]);
      // An object with no stamp — `local/` deleted — is stamped by the first pass that sees it, and young from then.
      const orphan = (await store.putRaw(bytesOf(10, 31))).cid;
      await backend.remove(`${BASE}/${ACCEPTED_DIR}/${orphan}`);
      c.advance(100 * HOUR);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [orphan] });
      expect(await backend.modified(`${BASE}/${ACCEPTED_DIR}/${orphan}`)).toBe(c.now());
      c.advance(HOUR - 1);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [orphan] });
      c.advance(1);
      expect(await store.collect([])).toEqual({ unlinked: [orphan], young: [] });
      // A kept object's stamp stays, whatever its age.
      const kept = (await store.putRaw(bytesOf(10, 32))).cid;
      c.advance(100 * HOUR);
      expect(await store.collect([kept])).toEqual({ unlinked: [], young: [] });
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([kept]);
    });

    it("the stamp records a completed acceptance — a move that takes longer than grace leaves the object young; a crash before the stamp, on a first or a repeated acceptance, leaves it of unknown age, stamped and young at the next pass", async () => {
      const c = clock(T0);
      const { backend, store } = await fresh({ now: c.now, graceMs: HOUR });
      // The move itself takes longer than grace: the clock moves on inside `rename`.
      const slowMove = new Proxy(backend, {
        get: (target, key, receiver) => {
          if (key !== "rename") return Reflect.get(target, key, receiver) as unknown;
          return async (from: string, to: string): Promise<void> => {
            c.advance(2 * HOUR);
            await target.rename(from, to);
          };
        },
      });
      const slow = new FolderObjectStore(slowMove, storeOptions({ now: c.now, graceMs: HOUR }));
      const cid = (await slow.putRaw(bytesOf(10, 50))).cid;
      expect(await backend.modified(`${BASE}/${ACCEPTED_DIR}/${cid}`)).toBe(c.now()); // stamped when the move had completed
      expect(await store.collect([])).toEqual({ unlinked: [], young: [cid] });
      c.advance(HOUR - 1);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [cid] });
      c.advance(1);
      expect(await store.collect([])).toEqual({ unlinked: [cid], young: [] });
      // The stamp's write fails after the move: the object stands, unstamped, and is young at the next pass.
      let failStamp = false;
      const stampFails = new Proxy(backend, {
        get: (target, key, receiver) => {
          if (key !== "write") return Reflect.get(target, key, receiver) as unknown;
          return async (path: string, data: Uint8Array): Promise<void> => {
            if (failStamp && path.startsWith(`${BASE}/${ACCEPTED_DIR}/`)) throw new Error("stamp lost");
            await target.write(path, data);
          };
        },
      });
      const fragile = new FolderObjectStore(stampFails, storeOptions({ now: c.now, graceMs: HOUR }));
      failStamp = true;
      await expect(fragile.putRaw(bytesOf(10, 51))).rejects.toThrow("stamp lost");
      failStamp = false;
      const orphan = cidOf(bytesOf(10, 51));
      expect(await store.has(orphan)).toBe(true);
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([]);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [orphan] });
      expect(await backend.modified(`${BASE}/${ACCEPTED_DIR}/${orphan}`)).toBe(c.now());
      // A repeated acceptance whose stamp is lost: the old stamp was removed before the move, so the object is not judged by it.
      c.advance(2 * HOUR);
      failStamp = true;
      await expect(fragile.putObject(orphan, bytesOf(10, 51))).rejects.toThrow("stamp lost");
      failStamp = false;
      expect(await namesUnder(backend, ACCEPTED_DIR)).toEqual([]);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [orphan] });
      expect(await store.has(orphan)).toBe(true);
    });

    it("an entry under objects/ that is not an object path is damage — reported, listed as nothing, left by collection, moved aside by verify", async () => {
      const c = clock(T0);
      const { backend, store } = await fresh({ now: c.now, graceMs: 0 });
      const cid = (await store.putRaw(HELLO)).cid;
      const junk = [...BAD_CIDS.map(([, bad]) => bad).filter((bad) => bad !== "" && !bad.includes("=")), `${cid}.a1b2c3.tmp`];
      for (const name of junk) await backend.write(`${BASE}/objects/${name}`, HELLO);
      await backend.write(`${BASE}/objects/nested/deeper`, HELLO);
      expect(await all(store.list())).toEqual([cid]);
      const damaged = await store.damaged();
      expect(damaged.map((d) => d.where).sort()).toEqual([...junk.map((name) => `objects/${name}`), "objects/nested"].sort());
      for (const d of damaged) expect(d.error).toMatch(d.where === "objects/nested" ? /directory/ : /not a canonical raw DASL CID/);
      expect(await store.collect([cid])).toEqual({ unlinked: [], young: [] });
      expect((await namesUnder(backend, "objects")).length).toBe(junk.length + 1); // collection touches only objects
      const verified = await store.verify();
      expect(verified.map((d) => d.where).sort()).toEqual(damaged.map((d) => d.where).sort());
      expect(await namesUnder(backend, "objects")).toEqual([cid]);
      expect(await namesUnder(backend, DAMAGED_DIR)).toEqual([...junk].sort());
      expect(await backend.dirs(`${BASE}/objects`)).toEqual(["nested"]); // reported, not moved
      expect(await store.verify()).toEqual([{ where: "objects/nested", error: "a directory where an object belongs" }]);
    });

    it("verify reads every object whole and moves aside the ones whose bytes do not spell their names, reporting the CID the bytes do have", async () => {
      const { backend, store } = await fresh();
      const good = bytesOf(3_000, 14);
      const goodCid = (await store.putRaw(good)).cid;
      const bad = bytesOf(3_000, 15);
      const badCid = (await store.putRaw(bad)).cid;
      const wrong = bytesOf(3_000, 16);
      await backend.write(`${BASE}/${objectPath(badCid)}`, wrong);
      expect(await store.verify()).toEqual([{ where: objectPath(badCid), error: `the bytes hash to ${cidOf(wrong)}, not the name` }]);
      expect(await all(store.list())).toEqual([goodCid]);
      expectBytes(await fileAt(backend, `${DAMAGED_DIR}/${badCid}`), wrong);
      expectBytes(await store.read(goodCid, 3_000), good);
      expect(await store.verify()).toEqual([]);
    });

    it("a file where objects/ belongs is damage — reported, an empty store to read, and refused by every put before a byte lands", async () => {
      const { backend, store } = await fresh();
      await backend.write(`${BASE}/objects`, HELLO);
      expect(await store.damaged()).toEqual([{ where: "objects", error: "a file where the objects directory belongs" }]);
      expect(await all(store.list())).toEqual([]);
      expect(await store.has(HELLO_CID)).toBe(false);
      expect(await store.stat(HELLO_CID)).toBeNull();
      expect(await store.open(HELLO_CID)).toBeNull();
      let pulled = 0;
      async function* counting(): AsyncIterable<Uint8Array> {
        pulled += 1;
        yield HELLO;
      }
      await expect(store.putRaw(counting())).rejects.toThrow(DamagedLayout);
      await expect(store.putObject(HELLO_CID, counting())).rejects.toThrow(DamagedLayout);
      expect(pulled).toBe(0);
      expect(await namesUnder(backend, STAGING_DIR)).toEqual([]);
      expect(await store.collect([])).toEqual({ unlinked: [], young: [] });
      expect(await store.verify()).toEqual([{ where: "objects", error: "a file where the objects directory belongs" }]);
      expectBytes(await backend.read(`${BASE}/objects`), HELLO); // untouched
    });

    it("across a reopen, an orphan's age is its file's — kept by a keep set, unlinked past grace; and the file is gone from the folder", async () => {
      const c = clock(T0);
      const { backend, store, reopen } = await fresh({ now: c.now, graceMs: HOUR });
      const kept = (await store.putRaw(bytesOf(10, 17))).cid;
      const orphan = (await store.putRaw(bytesOf(10, 18))).cid;
      c.advance(HOUR - 1);
      const again = reopen();
      expect(await again.collect([kept])).toEqual({ unlinked: [], young: [orphan] });
      c.advance(1);
      expect(await again.collect([kept])).toEqual({ unlinked: [orphan], young: [] });
      expect(await namesUnder(backend, "objects")).toEqual([kept]);
      expect(await fileAt(backend, objectPath(orphan))).toBeNull();
      expect(await again.has(kept)).toBe(true);
    });

    it("the latch: a stream opened by one store handle over the folder is honoured by another sharing its registry, and not by one that does not", async () => {
      const c = clock(T0);
      const { store, reopen } = await fresh({ now: c.now, graceMs: 0 });
      const cid = (await store.putRaw(bytesOf(10, 19))).cid;
      const stream = (await store.open(cid)) as ReadableStream<Uint8Array>;
      const sharing = reopen({ latches: store.latches });
      expect(await sharing.collect([])).toEqual({ unlinked: [], young: [] });
      expect(await store.has(cid)).toBe(true);
      await stream.cancel();
      expect(await sharing.collect([])).toEqual({ unlinked: [cid], young: [] });
    });
  });
}

describe("FolderObjectStore on disk", () => {
  it("a large object is one file on disk, streamed in and out in fixed pieces, no temp file beside it afterwards", async () => {
    const { backend, store, root } = await overDisk();
    const size = 6 * 1024 * 1024 + 3;
    const piece = 64 * 1024;
    async function* large(): AsyncIterable<Uint8Array> {
      for (let at = 0; at < size; at += piece) yield bytesOf(Math.min(piece, size - at), at + 1);
    }
    const info = await store.putRaw(large());
    expect(info.size).toBe(size);
    expect(await namesUnder(backend, "objects")).toEqual([info.cid]);
    const onDisk = await readFile(path.join(root as string, BASE, "objects", info.cid));
    expect(onDisk.length).toBe(size);
    expect(cidOf(new Uint8Array(onDisk))).toBe(info.cid);
    let chunks = 0;
    let seen = 0;
    for await (const chunk of chunksOf((await store.open(info.cid)) as ReadableStream<Uint8Array>)) {
      chunks += 1;
      seen += chunk.length;
    }
    expect(seen).toBe(size);
    expect(chunks).toBeGreaterThan(1);
  });

  it("a file handle that takes only part of each write is written until every byte is down; the file is the whole object", async () => {
    const { store, root } = await overDisk();
    const probe = await fsOpen(path.join(root as string, "probe"), "w");
    type Write = (this: unknown, buffer: Uint8Array, ...rest: unknown[]) => Promise<{ bytesWritten: number }>;
    const proto = Object.getPrototypeOf(probe) as { write: Write };
    await probe.close();
    const original = proto.write;
    let calls = 0;
    proto.write = function (this: unknown, buffer: Uint8Array, ...rest: unknown[]) {
      calls += 1;
      return original.call(this, buffer.subarray(0, Math.max(1, Math.floor(buffer.length / 2))), ...rest);
    };
    try {
      const bytes = bytesOf(1_000, 40);
      const info = await store.putRaw(chunked(bytes, [400, 600]));
      expect(info).toEqual({ cid: cidOf(bytes), codec: "raw", size: 1_000 });
      expectBytes(new Uint8Array(await readFile(path.join(root as string, BASE, "objects", info.cid))), bytes);
      expect(calls).toBeGreaterThan(2);
    } finally {
      proto.write = original;
    }
  });

  it("with the platform's clock, an object whose source idled after its last chunk is young right after acceptance, and a reopened store reads the same acceptance", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const store = new FolderObjectStore(backend, { base: BASE, graceMs: 100 });
    async function* idling(): AsyncIterable<Uint8Array> {
      yield HELLO;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    const cid = (await store.putRaw(idling())).cid;
    expect(await store.collect([])).toEqual({ unlinked: [], young: [cid] });
    expect(await new FolderObjectStore(backend, { base: BASE, graceMs: 100 }).collect([])).toEqual({ unlinked: [], young: [cid] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await new FolderObjectStore(backend, { base: BASE, graceMs: 100 }).collect([])).toEqual({ unlinked: [cid], young: [] });
  });

  it("with the platform's clock, a move that waits longer than grace before completing leaves the object young right after acceptance, in this store and a reopened one", async () => {
    const dir = await tempDir();
    const backend = new FsBackend(dir);
    const slowMove = new Proxy(backend, {
      get: (target, key, receiver) => {
        if (key !== "rename") return Reflect.get(target, key, receiver) as unknown;
        return async (from: string, to: string): Promise<void> => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await target.rename(from, to);
        };
      },
    });
    const store = new FolderObjectStore(slowMove, { base: BASE, graceMs: 100 });
    const cid = (await store.putRaw(HELLO)).cid;
    expect(await store.collect([])).toEqual({ unlinked: [], young: [cid] });
    expect(await new FolderObjectStore(backend, { base: BASE, graceMs: 100 }).collect([])).toEqual({ unlinked: [], young: [cid] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await new FolderObjectStore(backend, { base: BASE, graceMs: 100 }).collect([])).toEqual({ unlinked: [cid], young: [] });
  });

  it("on disk: a byte flipped in the file behind the backend's back fails the read and moves the file aside", async () => {
    const { store, root, backend } = await overDisk();
    const bytes = bytesOf(100_000, 20);
    const cid = (await store.putRaw(bytes)).cid;
    await corruptOnDisk(root as string, cid);
    await expect(store.read(cid, 100_000)).rejects.toThrow(DamagedObject);
    expect(await store.has(cid)).toBe(false);
    expect(await namesUnder(backend, DAMAGED_DIR)).toEqual([cid]);
  });
});
