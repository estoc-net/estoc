import { describe, expect, it } from "vitest";

import {
  AnchorMismatch,
  DamagedLayout,
  DamagedObject,
  DamagedReplica,
  FolderReader,
  FolderVault,
  ForkedAuthor,
  MemoryBackend,
  NotAVault,
  OWNER_FILE,
  PendingImport,
  ReadOnlyVault,
  Unprotected,
  VaultClosed,
  VaultOwned,
  isUuidv7,
  text,
  utf8,
  type Cid,
  type Draft,
  type Replica,
  type VaultBackend,
} from "../../../src/v3/index.js";
import { all, authorN, clock, expectBytes, ids } from "../suite/helpers.js";
import { HELLO_CID, cidOf, drain } from "../suite/object-store-suite.js";

async function bytesOfStream(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) throw new Error("expected a stream");
  return (await drain(stream)).bytes;
}

const BASE = ".estoc";
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";
const JWE = "eyJhbGciOiJQQkVTMi1IUzUxMitBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwicDJjIjoyMjAwMDAsInAycyI6IkFCQ0QifQ.QUJDRA.QUJDRA.QUJDRA.QUJDRA";
const KEYSTORE = utf8(`${JSON.stringify({ version: 3, seedJwe: JWE }, null, 2)}\n`);
const HELLO = new TextEncoder().encode("hello");
const HOUR = 60 * 60 * 1000;

const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

/** A fresh vault in memory, created and open for writing. */
async function created(backend = new MemoryBackend(), options: Partial<Parameters<typeof FolderVault.create>[1]> = {}): Promise<FolderVault> {
  return FolderVault.create(backend, { anchor: DID, keystore: KEYSTORE, ...options });
}

/** The paths under `base` in `backend`, sorted. */
function paths(backend: MemoryBackend, base = BASE): string[] {
  return [...backend.files.keys()].filter((p) => p.startsWith(`${base}/`)).sort();
}

/** Every path of `from` copied into a fresh backend, `local/` and `import/` left out when `portable`: what a snapshot and restore do, by hand. */
function copied(from: MemoryBackend, portable: boolean): MemoryBackend {
  const to = new MemoryBackend();
  for (const [path, bytes] of from.files) {
    if (portable && (path.startsWith(`${BASE}/local/`) || path.startsWith(`${BASE}/import/`))) continue;
    to.files.set(path, new Uint8Array(bytes));
  }
  return to;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function* gated(bytes: Uint8Array, g: { wait: Promise<void> }): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 1);
  await g.wait;
  yield bytes.slice(1);
}

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await tick();
  return done;
}

describe("FolderVault.create", () => {
  it("lays down keystore.json then config.json, mints local/replica.json, appends no event, and writes events under events/<replica_id>/", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    expect(paths(backend)).toEqual([`${BASE}/config.json`, `${BASE}/keystore.json`, `${BASE}/local/replica.json`]); // ownership in memory makes no file
    expect(text(backend.files.get(`${BASE}/config.json`) as Uint8Array)).toBe(
      `{\n  "format": "estoc",\n  "version": 3,\n  "identity": {\n    "anchor": {\n      "key": "anchor",\n      "did": "${DID}"\n    }\n  }\n}\n`
    );
    expectBytes(backend.files.get(`${BASE}/keystore.json`), KEYSTORE);
    expect(vault.config.identity.anchor.did).toBe(DID);
    expect(isUuidv7(vault.replica.replica_id)).toBe(true);
    expect(vault.author).toBe(vault.replica.replica_id);
    expect(vault.generation).toBe(vault.replica.store_generation);
    expect(await all(vault.vault.events.scan())).toEqual([]);
    const [event] = await vault.vault.commit([], [draft()]);
    expect(event?.author).toBe(vault.replica.replica_id);
    const segments = paths(backend).filter((p) => p.includes("/events/"));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(new RegExp(`^${BASE}/events/${vault.replica.replica_id}/[0-9a-f-]+\\.jsonl$`));
    await vault.close();
  });

  it("refuses a keystore of the wrong shape and an anchor the config parser would refuse — before ownership is taken or anything written — and an existing vault", async () => {
    const backend = new MemoryBackend();
    await expect(FolderVault.create(backend, { anchor: DID, keystore: utf8(JSON.stringify({ version: 3, seedJwe: JWE, keys: [] })) })).rejects.toThrow(NotAVault);
    for (const anchor of ["did:web:example.com", "did:key:", "", 7 as unknown as string]) {
      await expect(FolderVault.create(backend, { anchor, keystore: KEYSTORE }), JSON.stringify(anchor)).rejects.toThrow(NotAVault);
    }
    expect(paths(backend)).toEqual([]);
    const held = await backend.own(`${BASE}/${OWNER_FILE}`); // nothing leaked
    await held.release();
    const vault = await created(backend);
    await vault.close();
    await expect(created(backend)).rejects.toThrow(/not an empty folder/);
    expectBytes(backend.files.get(`${BASE}/keystore.json`), KEYSTORE);
  });

  it("refuses a folder that is not empty — a seed wrapper, recovery state, a segment, an opaque file, leftover local state — leaving every byte as it was and ownership free", async () => {
    const previous = utf8(JSON.stringify({ version: 3, seedJwe: "e30.BB.BB.BB.BB" }));
    const residues: [string, Record<string, Uint8Array>][] = [
      ["a seed wrapper and an import journal", { [`${BASE}/keystore.json`]: previous, [`${BASE}/import/job/journal.json`]: utf8("{}") }],
      ["a seed wrapper alone", { [`${BASE}/keystore.json`]: previous }],
      ["a segment", { [`${BASE}/events/${authorN(1)}/${authorN(2)}.jsonl`]: utf8("") }],
      ["an object", { [`${BASE}/objects/${HELLO_CID}`]: HELLO }],
      ["an opaque file", { [`${BASE}/notes.txt`]: utf8("hi") }],
      ["leftover local state", { [`${BASE}/local/replica.json`]: utf8("{}") }],
      ["leftover local owner state", { [`${BASE}/local/agent/options.json`]: utf8("{}") }],
    ];
    for (const [what, files] of residues) {
      const backend = new MemoryBackend();
      for (const [path, bytes] of Object.entries(files)) backend.files.set(path, bytes);
      const before = [...backend.files.entries()].map(([path, bytes]) => [path, [...bytes]]);
      await expect(created(backend), what).rejects.toThrow(/not an empty folder/);
      expect([...backend.files.entries()].map(([path, bytes]) => [path, [...bytes]]), what).toEqual(before);
      const held = await backend.own(`${BASE}/${OWNER_FILE}`);
      await held.release();
    }
  });

  it("two creates of one folder are excluded by ownership: the loser writes nothing", async () => {
    const backend = new MemoryBackend();
    const first = await created(backend);
    await expect(FolderVault.create(backend, { anchor: OTHER_DID, keystore: KEYSTORE })).rejects.toThrow(/not an empty folder/);
    // and with config.json not yet there — ownership held by another create in flight
    const empty = new MemoryBackend();
    const held = await empty.own(`${BASE}/${OWNER_FILE}`);
    await expect(created(empty)).rejects.toThrow(VaultOwned);
    expect(paths(empty)).toEqual([]);
    await held.release();
    await first.close();
  });
});

describe("FolderVault.openWritable", () => {
  it("steps 1–3 before step 4: no config, another version, no keystore, a keystore of another shape, or the wrong seed — each refused with nothing taken and nothing written", async () => {
    const fresh = new MemoryBackend();
    await expect(FolderVault.openWritable(fresh, { anchor: DID })).rejects.toThrow(NotAVault);
    expect(paths(fresh)).toEqual([]);

    const backend = new MemoryBackend();
    const vault = await created(backend);
    await vault.close();
    const before = paths(backend);
    const config = backend.files.get(`${BASE}/config.json`) as Uint8Array;
    const keystore = backend.files.get(`${BASE}/keystore.json`) as Uint8Array;

    await expect(FolderVault.openWritable(backend, { anchor: OTHER_DID })).rejects.toThrow(AnchorMismatch);
    await expect(FolderVault.openWritable(backend, { anchor: OTHER_DID })).rejects.toThrow(/wrong seed for this vault/);
    expect(paths(backend)).toEqual(before);

    backend.files.set(`${BASE}/keystore.json`, utf8(JSON.stringify({ version: 3, seedJwe: JWE, keys: [] })));
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(/derived-key cache/);
    backend.files.delete(`${BASE}/keystore.json`);
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(/no .estoc\/keystore.json/);
    backend.files.set(`${BASE}/keystore.json`, keystore);

    backend.files.set(`${BASE}/config.json`, utf8(text(config).replace('"version": 3', '"version": 2')));
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(/version 2 is not 3; this reader opens version 3 vaults only/);
    backend.files.set(`${BASE}/config.json`, config);
    expect(paths(backend)).toEqual(before);

    // after every refusal, ownership was never taken: a proper open succeeds
    const again = await FolderVault.openWritable(backend, { anchor: DID });
    expect(again.replica).toEqual(vault.replica);
    await again.close();
  });

  it("ownership is exclusive — a second writable open, or an exclusive read-only open, is VaultOwned until close; after close the vault refuses everything", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(VaultOwned);
    await expect(FolderReader.open(backend, { ownership: "exclusive" })).rejects.toThrow(VaultOwned);
    const reader = await FolderReader.open(backend); // without ownership: fine beside a writer
    expect(reader.owned).toBe(false);
    await reader.close();
    expect(vault.open).toBe(true);
    await vault.close();
    expect(vault.open).toBe(false);
    await vault.close(); // twice is fine
    await expect(vault.vault.commit([], [draft()])).rejects.toThrow(VaultClosed);
    await expect(vault.vault.files.write("x", utf8(""))).rejects.toThrow(VaultClosed);
    await expect(vault.vault.objects.open(HELLO_CID)).rejects.toThrow(VaultClosed);
    await expect(vault.collect(() => [])).rejects.toThrow(VaultClosed);
    await expect(vault.ingest([])).rejects.toThrow(VaultClosed);
    expect(() => vault.local("agent")).toThrow(VaultClosed);
    const next = await FolderVault.openWritable(backend, { anchor: DID });
    expect(next.replica).toEqual(vault.replica);
    await next.close();
  });

  it("close waits for the operation holding the lock, and what was queued after close is refused", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    const g = gate();
    const commit = vault.vault.commit([{ cid: HELLO_CID, source: gated(HELLO, g) }], [draft([HELLO_CID])]);
    await tick();
    const closing = vault.close();
    expect(await settled(closing)).toBe(false);
    await expect(vault.vault.commit([], [draft()])).rejects.toThrow(VaultClosed);
    g.open();
    await commit;
    await closing;
    expect(await all(vault.stores.events.scan())).toHaveLength(1);
  });

  for (const mode of ["writer", "reader"] as const) {
    it(`${mode}: close fails every object stream still alive and releases its latch before ownership goes, so the next writer collects nothing a stream was reading`, async () => {
      const backend = new MemoryBackend();
      const vault = await created(backend, { graceMs: 0 });
      await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], []);
      if (mode === "reader") await vault.close();
      const owner = mode === "writer" ? vault : await FolderReader.open(backend, { ownership: "exclusive" });
      const objects = mode === "writer" ? vault.vault.objects : (owner as FolderReader).objects;
      const stream = (await objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      expect(owner.stores.objects.latches.count(HELLO_CID)).toBe(1);
      await owner.close();
      expect(owner.stores.objects.latches.count(HELLO_CID)).toBe(0);
      await expect(reader.read()).rejects.toThrow(VaultClosed);
      // the folder is free, and nothing of the old runtime reads it: collection takes the object
      const next = await FolderVault.openWritable(backend, { anchor: DID, graceMs: 0 });
      expect((await next.collect(() => [])).unlinked).toEqual([HELLO_CID]);
      await next.close();
      // a stream half consumed fails at its next read too
      const again = await created(new MemoryBackend(), { graceMs: 0 });
      await again.vault.commit([{ cid: HELLO_CID, source: HELLO }], []);
      const half = (await again.vault.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
      const halfReader = half.getReader();
      expect((await halfReader.read()).done).toBe(false);
      await again.close();
      await expect(halfReader.read()).rejects.toThrow(VaultClosed);
      expect(again.stores.objects.latches.latched()).toEqual([]);
    });
  }

  it("an open queued behind the operation holding the lock when close is called still runs, registers its stream, and is failed before ownership goes", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend, { graceMs: 0 });
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], []);
    const g = gate();
    const world = new TextEncoder().encode("world");
    const commit = vault.vault.commit([{ cid: cidOf(world), source: gated(world, g) }], []);
    await tick();
    const opening = vault.vault.objects.open(HELLO_CID); // queued behind the commit
    const closing = vault.close();
    await tick();
    expect(await settled(opening)).toBe(false);
    expect(await settled(closing)).toBe(false);
    await expect(vault.vault.objects.open(HELLO_CID)).rejects.toThrow(VaultClosed); // queued after close: refused
    g.open();
    await commit;
    const stream = (await opening) as ReadableStream<Uint8Array>;
    await closing;
    await expect(stream.getReader().read()).rejects.toThrow(VaultClosed);
    expect(vault.stores.objects.latches.latched()).toEqual([]);
    const next = await FolderVault.openWritable(backend, { anchor: DID, graceMs: 0 });
    expect((await next.collect(() => [])).unlinked).toEqual([HELLO_CID, cidOf(world)].sort());
    await next.close();
  });

  it("a quarantine a damaged stream queues behind close does nothing — the next writer's object, put back sound, stays; verify after close is refused", async () => {
    const backend = new MemoryBackend();
    const renames: string[] = [];
    let holdStat: ReturnType<typeof gate> | null = null;
    const controlled = new Proxy(backend, {
      get(target, key, receiver) {
        if (key === "size") {
          return async (file: string) => {
            if (holdStat !== null && file === `${BASE}/objects/${HELLO_CID}`) {
              const g = holdStat;
              holdStat = null;
              await g.wait;
            }
            return target.size(file);
          };
        }
        if (key === "rename") {
          return (from: string, to: string) => {
            renames.push(from);
            return target.rename(from, to);
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const first = await created(controlled, { graceMs: 0 });
    await first.vault.commit([{ cid: HELLO_CID, source: HELLO }], []);
    await backend.write(`${BASE}/objects/${HELLO_CID}`, utf8("wrong")); // damaged behind the store's back
    const reader = ((await first.vault.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>).getReader();
    expect((await reader.read()).done).toBe(false);
    // the store's turn is held by a stat; close queues behind it, and the stream's end — the digest mismatch — queues its quarantine behind close
    const g = gate();
    holdStat = g;
    const stat = first.vault.objects.stat(HELLO_CID);
    await tick();
    const closing = first.close();
    await tick(); // the vault's close has reached the store: its close is queued behind the stat
    const lastRead = reader.read().then(
      () => "resolved",
      (err: Error) => err.name
    );
    await tick();
    g.open();
    await stat;
    await closing;
    expect(await lastRead).toBe("VaultClosed");
    // the folder is the next writer's: it puts the object back sound and commits a reference to it
    const next = await FolderVault.openWritable(backend, { anchor: DID, graceMs: 0 });
    await next.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await tick();
    expect(await next.vault.objects.has(HELLO_CID)).toBe(true);
    expectBytes(await next.vault.objects.read(HELLO_CID, 100), HELLO);
    expect(paths(backend).filter((p) => p.includes("/damaged/"))).toEqual([]);
    expect(renames.filter((p) => p === `${BASE}/objects/${HELLO_CID}`)).toEqual([]); // the old runtime moved nothing after its close
    await expect(first.stores.objects.verify()).rejects.toThrow(VaultClosed);
    await next.close();
  });

  it("a local owner, cache or trace handle taken before close refuses every operation after it, and close waits for the local work accepted before", async () => {
    const backend = new MemoryBackend();
    const g = gate();
    let gating = true;
    const slow = new Proxy(backend, {
      get(target, prop, receiver) {
        if (prop !== "write") return Reflect.get(target, prop, receiver);
        return async (path: string, bytes: Uint8Array) => {
          if (gating && path.endsWith("/options.json")) await g.wait;
          return target.write(path, bytes);
        };
      },
    }) as MemoryBackend;
    const vault = await FolderVault.create(slow, { anchor: DID, keystore: KEYSTORE });
    const local = vault.local("agent");
    const cache = local.cache;
    const trace = local.trace("wire");
    const inFlight = local.writeOptions({ accepted: true }); // accepted before close: runs out before ownership goes
    await tick();
    const closing = vault.close();
    await tick();
    expect(await settled(closing)).toBe(false);
    await expect(backend.own(`${BASE}/${OWNER_FILE}`)).rejects.toThrow(VaultOwned); // still held while the write runs
    const event = { eventId: authorN(1), at: "2026-09-07T10:00:00.000Z", type: "wire.out", data: {} };
    await expect(local.writeOptions({ obsolete: true })).rejects.toThrow(VaultClosed);
    await expect(local.readOptions()).rejects.toThrow(VaultClosed);
    await expect(cache.write("x", utf8(""))).rejects.toThrow(VaultClosed);
    await expect(cache.read("x")).rejects.toThrow(VaultClosed);
    await expect(cache.list()).rejects.toThrow(VaultClosed);
    await expect(cache.remove("x")).rejects.toThrow(VaultClosed);
    await expect(cache.clear()).rejects.toThrow(VaultClosed);
    await expect(trace.append(event)).rejects.toThrow(VaultClosed);
    await expect(all(trace.scan())).rejects.toThrow(VaultClosed);
    await expect(trace.prune({ keepMs: 0, capBytes: 0 })).rejects.toThrow(VaultClosed);
    expect(() => local.trace("other")).toThrow(VaultClosed);
    expect(() => local.cache).toThrow(VaultClosed);
    g.open();
    gating = false;
    await inFlight;
    await closing;
    const next = await FolderVault.openWritable(backend, { anchor: DID });
    expect(await next.local("agent").readOptions()).toEqual({ accepted: true });
    await next.close();
  });

  it("anything under import/ blocks a writable open and a read-only open alike, with ownership released; an empty import/ is nothing pending", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await vault.close();
    backend.files.set(`${BASE}/import/019b2a43-4a56-7c0f-862f-194c0c4124a0/journal.json`, utf8("{}"));
    backend.files.set(`${BASE}/import/stray`, utf8(""));
    const pending = await FolderVault.openWritable(backend, { anchor: DID }).catch((err: unknown) => err);
    expect(pending).toBeInstanceOf(PendingImport);
    expect((pending as PendingImport).entries).toEqual(["019b2a43-4a56-7c0f-862f-194c0c4124a0", "stray"]);
    await expect(FolderReader.open(backend)).rejects.toThrow(PendingImport);
    // ownership was released on the refusal
    const held = await backend.own(`${BASE}/${OWNER_FILE}`);
    await held.release();
    for (const path of [...backend.files.keys()].filter((p) => p.startsWith(`${BASE}/import/`))) backend.files.delete(path);
    const again = await FolderVault.openWritable(backend, { anchor: DID });
    await again.close();
  });

  it("a file where import/ or local/ belongs is DamagedLayout, refused before ownership; a directory where config.json belongs is no vault", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await vault.close();
    const local = [...backend.files.entries()].filter(([p]) => p.startsWith(`${BASE}/local/`));
    for (const [p] of local) backend.files.delete(p);
    backend.files.set(`${BASE}/local`, utf8("not a directory"));
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(DamagedLayout);
    await expect(FolderReader.open(backend)).rejects.toThrow(/a file where the local directory belongs/);
    backend.files.delete(`${BASE}/local`);
    backend.files.set(`${BASE}/import`, utf8(""));
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(/a file where the import directory belongs/);
    backend.files.delete(`${BASE}/import`);
    const config = backend.files.get(`${BASE}/config.json`) as Uint8Array;
    backend.files.delete(`${BASE}/config.json`);
    backend.files.set(`${BASE}/config.json/x`, config);
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(/no .estoc\/config.json/);
    await expect(created(backend)).rejects.toThrow(/not an empty folder/);
  });

  it("a malformed local/replica.json is DamagedReplica, never repaired, and ownership is released", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await vault.close();
    backend.files.set(`${BASE}/local/replica.json`, utf8(`{"replica_id": "${vault.replica.replica_id}"}`));
    await expect(FolderVault.openWritable(backend, { anchor: DID })).rejects.toThrow(DamagedReplica);
    expect(text(backend.files.get(`${BASE}/local/replica.json`) as Uint8Array)).toBe(`{"replica_id": "${vault.replica.replica_id}"}`);
    backend.files.delete(`${BASE}/local/replica.json`);
    const fresh = await FolderVault.openWritable(backend, { anchor: DID });
    expect(fresh.replica.replica_id).not.toBe(vault.replica.replica_id);
    await fresh.close();
  });

  it("the portable half restored elsewhere opens as a new replica and generation, keeps every old author's events, and writes under the new author", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    const [old] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.local("agent").writeOptions({ theme: "dark" });
    await vault.close();
    const target = copied(source, true);
    expect(paths(target).some((p) => p.includes("/local/"))).toBe(false);
    const restored = await FolderVault.openWritable(target, { anchor: DID });
    expect(restored.replica.replica_id).not.toBe(vault.replica.replica_id);
    expect(restored.replica.store_generation).not.toBe(vault.replica.store_generation);
    expect(ids(await all(restored.vault.events.scan()))).toEqual([old?.eventId]);
    expectBytes(await restored.vault.objects.read(HELLO_CID, 1024), HELLO);
    expect(await restored.local("agent").readOptions()).toBeNull();
    const [fresh] = await restored.vault.commit([], [draft()]);
    expect(fresh?.author).toBe(restored.replica.replica_id);
    expect(paths(target).filter((p) => p.includes("/events/")).map((p) => p.split("/")[2]).sort()).toEqual([vault.replica.replica_id, restored.replica.replica_id].sort());
    await restored.close();
    // the same snapshot restored on a third machine is a third replica: nothing of the machine names it
    const third = await FolderVault.openWritable(copied(source, true), { anchor: DID });
    expect(third.replica.replica_id).not.toBe(restored.replica.replica_id);
    await third.close();
  });

  it("the whole folder moved, local/ included, keeps the replica; copied and left active on both sides it is a fork, which ingest detects", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    await vault.vault.commit([], [draft()]);
    await vault.local("agent").writeOptions({ theme: "dark" });
    await vault.close();
    const moved = await FolderVault.openWritable(copied(source, false), { anchor: DID });
    expect(moved.replica).toEqual(vault.replica);
    expect(await moved.local("agent").readOptions()).toEqual({ theme: "dark" });
    // the old copy written to again: two writers under one replica
    const old = await FolderVault.openWritable(source, { anchor: DID });
    const [theirs] = await old.vault.commit([], [draft([], { side: "old" })]);
    await moved.vault.commit([], [draft([], { side: "moved" })]);
    await expect(moved.ingest([theirs])).rejects.toThrow(ForkedAuthor);
    await old.close();
    await moved.close();
  });

  it("state/ is an opaque path like any other; files reach config.json and keystore.json to read, never to write; local/ and import/ are never listed", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await vault.vault.files.write("state/settings.json", utf8("{}"));
    await vault.vault.files.write("notes.txt", utf8("hi"));
    await vault.local("agent").cache.write("fold.json", utf8("{}"));
    expect(await vault.vault.files.list()).toEqual(["config.json", "keystore.json", "notes.txt", "state/settings.json"]);
    expectBytes(await vault.vault.files.read("config.json"), backend.files.get(`${BASE}/config.json`) as Uint8Array);
    await expect(vault.vault.files.write("config.json", utf8("{}"))).rejects.toThrow(/owned by the layout/);
    await expect(vault.vault.files.write("local/agent/options.json", utf8("{}"))).rejects.toThrow(/owned by the layout/);
    expect(await vault.portablePaths()).toEqual(["config.json", "keystore.json", "notes.txt", "state/settings.json"]);
    await vault.close();
  });

  it("an entry the layout does not define inside a structural root is reported as damage, from every root, in path order", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    backend.files.set(`${BASE}/events/stray.txt`, utf8(""));
    backend.files.set(`${BASE}/events/${authorN(1)}/notes`, utf8(""));
    backend.files.set(`${BASE}/objects/not-a-cid`, utf8(""));
    backend.files.set(`${BASE}/objects/${HELLO_CID}/x`, utf8(""));
    backend.files.set(`${BASE}/keystore.json/x`, utf8(""));
    expect((await vault.damaged()).map((d) => d.where)).toEqual([
      `events/${authorN(1)}/notes`,
      "events/stray.txt",
      "keystore.json",
      `objects/${HELLO_CID}`,
      "objects/not-a-cid",
    ]);
    expect(await vault.vault.files.list()).toEqual(["config.json", "keystore.json"]);
    await vault.close();
  });

  it("the writer lock serializes a commit, the held-root fold and the collection pass — the keep set is computed after the commit it waited for", async () => {
    const c = clock("2026-09-07T10:00:00Z");
    const backend = new MemoryBackend({ clock: () => new Date(c.now()) });
    const vault = await created(backend, { now: c.now, graceMs: HOUR });
    const [first] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const world = new TextEncoder().encode("world");
    const worldCid = cidOf(world);
    const g = gate();
    const commit = vault.vault.commit([{ cid: worldCid, source: gated(world, g) }], [draft([worldCid])]);
    await tick();
    let seen: string[] = [];
    const collect = vault.collect(async (held) => {
      const events = await all(held.events.scan());
      seen = ids(events);
      return events.flatMap((event) => event.roots);
    });
    const write = vault.vault.files.write("notes.txt", utf8("hi"));
    await tick();
    expect(await settled(collect)).toBe(false);
    expect(await settled(write)).toBe(false);
    g.open();
    const [second] = await commit;
    await write;
    expect(await collect).toEqual({ unlinked: [], young: [] });
    expect(seen).toEqual(ids([first, second].filter((e) => e !== undefined)).sort());
    // an unkept object past grace goes in a later pass; a kept one stays
    c.advance(2 * HOUR);
    expect(await vault.collect(() => [HELLO_CID])).toEqual({ unlinked: [worldCid], young: [] });
    expect(await vault.vault.objects.has(HELLO_CID)).toBe(true);
    await vault.close();
  });

  it("commit, ingest and the nested view work over the folder as over memory: a draft root must be a present object, and ingest writes under the incoming author", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    await expect(vault.vault.commit([], [draft([HELLO_CID])])).rejects.toThrow(/not a present accepted object/);
    const other = await created(new MemoryBackend(), { mint: (): Replica => ({ replica_id: authorN(7), store_generation: authorN(8) }) });
    const [theirs] = await other.vault.commit([], [draft()]);
    expect(await vault.ingest([theirs])).toEqual({ added: 1, duplicates: 0, conflicts: [], rejected: [] });
    expect(paths(backend).some((p) => p.startsWith(`${BASE}/events/${authorN(7)}/`))).toBe(true);
    const n = await vault.locked(async (held) => {
      await held.commit([], [draft()]);
      return (await all(held.events.scan())).length;
    });
    expect(n).toBe(2);
    await other.close();
    await vault.close();
  });

  it("local(owner) is this copy's own under local/<owner>/, never portable, and an owner name is a lowercase word", async () => {
    const backend = new MemoryBackend();
    const vault = await created(backend);
    const agent = vault.local("agent");
    expect(vault.local("agent")).toBe(agent);
    await agent.writeOptions({ a: 1 });
    await agent.trace("wire").append({ eventId: authorN(1), at: "2026-09-07T10:00:00.000Z", type: "wire.out", data: {} });
    expect(paths(backend).filter((p) => p.startsWith(`${BASE}/local/agent/`)).map((p) => p.split("/").slice(3, 5).join("/"))).toEqual(["options.json", "trace/wire"]);
    expect(await vault.portablePaths()).toEqual(["config.json", "keystore.json"]);
    for (const name of ["Agent", "agent/x", "", "1st", "local"]) {
      if (name === "local") continue;
      expect(() => vault.local(name), name).toThrow(/not a local owner name/);
    }
    await vault.close();
  });
});

describe("FolderReader", () => {
  it("opens the portable half alone, creates no local/, and reads events, files and object metadata; writes are ReadOnlyVault", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    const [event] = await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.vault.files.write("notes.txt", utf8("hi"));
    await vault.close();
    const backend = copied(source, true);
    const before = paths(backend);
    const reader = await FolderReader.open(backend);
    expect(reader.config.identity.anchor.did).toBe(DID);
    expect(ids(await all(reader.events.scan()))).toEqual([event?.eventId]);
    expect(await reader.files.list()).toEqual(["config.json", "keystore.json", "notes.txt"]);
    expect(await reader.objects.has(HELLO_CID)).toBe(true);
    expect(await all(reader.objects.list())).toEqual([HELLO_CID]);
    expect((await reader.objects.stat(HELLO_CID))?.size).toBe(5);
    await expect(reader.files.write("notes.txt", utf8("x"))).rejects.toThrow(ReadOnlyVault);
    expect(await reader.damaged()).toEqual([]);
    await reader.close();
    expect(paths(backend)).toEqual(before);
    await expect(all(reader.events.scan())).rejects.toThrow(VaultClosed);
  });

  it("without ownership an object stream is refused as unprotected; with exclusive ownership it is served, and a writer meanwhile is VaultOwned", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.close();
    const bare = await FolderReader.open(source);
    await expect(bare.objects.open(HELLO_CID)).rejects.toThrow(Unprotected);
    await expect(bare.objects.read(HELLO_CID, 1024)).rejects.toThrow(Unprotected);
    await bare.close();
    const owning = await FolderReader.open(source, { ownership: "exclusive" });
    expect(owning.owned).toBe(true);
    expectBytes(await bytesOfStream(await owning.objects.open(HELLO_CID)), HELLO);
    expectBytes(await owning.objects.read(HELLO_CID, 1024), HELLO);
    await expect(FolderVault.openWritable(source, { anchor: DID })).rejects.toThrow(VaultOwned);
    await owning.close();
    const writer = await FolderVault.openWritable(source, { anchor: DID });
    await writer.close();
  });

  it("an object whose bytes do not spell its name fails the read and leaves the reader's view, but nothing in the folder moves or changes", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.close();
    const backend = copied(source, true);
    backend.files.set(`${BASE}/objects/${HELLO_CID}`, utf8("wrong"));
    backend.files.set(`${BASE}/objects/not-a-cid`, utf8(""));
    const snapshot = (): [string, number[]][] => [...backend.files.entries()].map(([path, bytes]): [string, number[]] => [path, [...bytes]]).sort();
    const before = snapshot();
    const reader = await FolderReader.open(backend, { ownership: "exclusive" });
    expect(await reader.objects.has(HELLO_CID)).toBe(true);
    await expect(reader.objects.read(HELLO_CID, 1024)).rejects.toThrow(DamagedObject);
    expect(snapshot()).toEqual(before);
    expect(await reader.objects.has(HELLO_CID)).toBe(false);
    expect(await reader.objects.stat(HELLO_CID)).toBeNull();
    expect(await reader.objects.open(HELLO_CID)).toBeNull();
    expect(await reader.objects.read(HELLO_CID, 1024)).toBeNull();
    expect(await all(reader.objects.list())).toEqual([]);
    expect((await reader.damaged()).map((d) => d.where)).toEqual([`objects/${HELLO_CID}`, "objects/not-a-cid"]);
    // verify on a read-only store reports and excludes, and moves nothing either
    const other = await FolderReader.open(copied(backend, true), { ownership: "exclusive" });
    expect((await other.stores.objects.verify()).map((d) => d.where)).toEqual([`objects/${HELLO_CID}`, "objects/not-a-cid"]);
    expect(await other.objects.has(HELLO_CID)).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(reader.stores.objects.latches.latched()).toEqual([]);
    await other.close();
    await reader.close();
  });

  it("refuses what a writable open refuses of the format, and needs no keystore to read", async () => {
    const source = new MemoryBackend();
    const vault = await created(source);
    await vault.close();
    const backend = copied(source, true);
    backend.files.delete(`${BASE}/keystore.json`);
    const reader = await FolderReader.open(backend);
    expect(await reader.files.list()).toEqual(["config.json"]);
    await reader.close();
    backend.files.set(`${BASE}/config.json`, utf8(JSON.stringify({ format: "estoc", version: 2 })));
    await expect(FolderReader.open(backend)).rejects.toThrow(/version 2 is not 3/);
    await expect(FolderReader.open(new MemoryBackend())).rejects.toThrow(NotAVault);
  });
});

/** The test above needs a backend whose type is the interface, so that it compiles against what a host hands in. */
export type _Check = VaultBackend;
