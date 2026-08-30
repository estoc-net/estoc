import { describe, expect, it } from "vitest";

import {
  DEVICE_MINTED,
  FolderVault,
  ForkedSelf,
  MemoryBackend,
  MemoryVault,
  NotAVault,
  NotSameVault,
  exportVault,
  importVault,
  isSegmentName,
  isUuidv7,
  restoreFolder,
  segmentTime,
  snapshot,
  type Event,
  type VaultFiles,
  type VaultStores,
} from "../src/index.js";
import { HELLO_CID, bigBytes } from "./suite/blob-suite.js";
import { all, clock } from "./suite/helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const EXT_A = "01990000-0000-7000-8000-00000000000a";
const EXT_B = "01990000-0000-7000-8000-00000000000b";
const EXT_C = "01990000-0000-7000-8000-00000000000c";
const ANCHOR = { identity: { anchor: { key: "anchor", did: "did:key:z6MkTest" } } };
const CONFIG = enc.encode(JSON.stringify({ format: "estoc", version: 2, ...ANCHOR }, null, 2) + "\n");
const OTHER_CONFIG = enc.encode(JSON.stringify({ format: "estoc", version: 2, identity: { anchor: { key: "anchor", did: "did:key:z6MkOther" } } }));

function keystore(seed: string, names: string[]): Uint8Array {
  return enc.encode(JSON.stringify({ version: 3, seedJwe: seed, keys: names.map((name) => ({ name, did: `did:key:${name}`, createdAt: "2026-08-30T00:00:00.000Z" })) }));
}

/** A memory vault that is a vault: a config, and its device announced. */
async function memoryVault(self: string, now: () => Date, config: Uint8Array = CONFIG): Promise<MemoryVault> {
  const vault = new MemoryVault({ self, clock: now });
  await vault.files.write("config.json", config);
  await vault.events.append({ type: DEVICE_MINTED, data: {} });
  return vault;
}

/** Events of another device, made honestly. */
async function foreign(self: string, now: () => Date, drafts: { type: string; data?: object; blobs?: string[] }[]): Promise<Event[]> {
  const other = await memoryVault(self, now);
  for (const draft of drafts) {
    await other.events.append({ type: draft.type, blobs: draft.blobs ?? [], data: (draft.data ?? {}) as Record<string, never> });
  }
  return all(other.events.scan());
}

/** A vault with something of everything: two authors, a small and a chunked blob, files, an extension store with a blob. */
async function populated(now: () => Date): Promise<{ vault: MemoryVault; big: string; tag: string }> {
  const vault = await memoryVault("aaaaaa", now);
  await vault.files.write("keystore.json", keystore("sealed-a", ["anchor", "k1"]));
  await vault.files.write("state/read.json", enc.encode("{}"));
  const hello = await vault.blobs.put(enc.encode("hello"));
  const big = await vault.blobs.put(bigBytes());
  await vault.events.append({ type: "message.in", blobs: [hello, big], data: { mid: "m1" } });
  await vault.events.ingest(await foreign("bbbbbb", now, [{ type: "t", data: { n: 1 } }, { type: "t", data: { n: 2 } }]));
  const ext = vault.extension(EXT_A);
  await ext.events.append({ type: "tag.added", data: { mid: "m1", tag: "x" } });
  const tag = await ext.blobs.put(enc.encode("tag"));
  await ext.events.append({ type: "tag.note", blobs: [tag], data: {} });
  return { vault, big, tag };
}

interface Contents {
  events: Record<string, Event[]>;
  blobs: Record<string, Record<string, Uint8Array>>;
  files: Record<string, string>;
}

/** Everything a vault holds, in a form two vaults can be compared by — less the `device.minted` of the devices named, which a folder mints on open. */
async function contents(vault: VaultStores, exceptMinted: string[] = []): Promise<Contents> {
  const out: Contents = { events: {}, blobs: {}, files: {} };
  const stores: [string, { events: VaultStores["events"]; blobs: VaultStores["blobs"] }][] = [["vault", vault]];
  for (const ext of await vault.extensions()) {
    stores.push([ext, vault.extension(ext)]);
  }
  for (const [name, s] of stores) {
    out.events[name] = (await all(s.events.scan())).filter((e) => !(e.type === DEVICE_MINTED && exceptMinted.includes(e.author)));
    const blobs: Record<string, Uint8Array> = {};
    for (const cid of await s.blobs.list()) {
      blobs[cid] = (await s.blobs.getBlock(cid)) as Uint8Array;
    }
    out.blobs[name] = blobs;
  }
  for (const path of await vault.files.list()) {
    out.files[path] = dec.decode((await vault.files.read(path)) as Uint8Array);
  }
  return out;
}

function paths(files: VaultFiles): string[] {
  return Object.keys(files).sort();
}

describe("snapshot", () => {
  it("is everything under .estoc/ except local/, byte for byte, whatever the path", async () => {
    const backend = new MemoryBackend();
    const vault = await FolderVault.create(backend, ANCHOR);
    await vault.events.append({ type: "t", data: {} });
    await vault.blobs.put(enc.encode("hello"));
    await vault.extension(EXT_A).events.append({ type: "t", data: {} });
    await vault.files.write("state/x.json", enc.encode("{}"));
    await vault.local("agent").writeOptions({ trace: "normal" });
    await backend.write(".estoc/notes.txt", enc.encode("carried"));
    await backend.write("outside.txt", enc.encode("not the vault"));
    const files = await snapshot(backend);
    expect(paths(files)).toEqual([
      ".estoc/blobs/" + HELLO_CID,
      ".estoc/config.json",
      ...[...backend.files.keys()].filter((p) => p.includes("/devices/")).sort(),
      ".estoc/notes.txt",
      ".estoc/state/x.json",
    ]);
    expect(paths(files).some((p) => p.startsWith(".estoc/local/"))).toBe(false);
    expect(files[".estoc/notes.txt"]).toEqual(enc.encode("carried"));
    expect(files[".estoc/config.json"]).toEqual(backend.files.get(".estoc/config.json"));
  });
});

describe("export", () => {
  it("renders any store as the folder: one segment per author, blobs flat, files in place, extensions beside, no local", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault, big, tag } = await populated(c.now);
    const files = await exportVault(vault, { clock: c.now });
    const segments = paths(files).filter((p) => p.endsWith(".jsonl"));
    expect(segments).toHaveLength(3);
    expect(segments.map((p) => p.replace(/[0-9a-f-]{36}\.jsonl$/, "<seg>.jsonl"))).toEqual([
      ".estoc/devices/aaaaaa/<seg>.jsonl",
      ".estoc/devices/bbbbbb/<seg>.jsonl",
      `.estoc/extensions/${EXT_A}/devices/aaaaaa/<seg>.jsonl`,
    ]);
    for (const path of segments) {
      const name = path.split("/").at(-1) as string;
      expect(isSegmentName(name)).toBe(true);
      expect(segmentTime(name.slice(0, -6))).toBe(c.now().getTime()); // minted from the export's clock
      const lines = dec.decode(files[path]).split("\n");
      expect(lines.at(-1)).toBe("");
      const events = lines.slice(0, -1).map((line) => JSON.parse(line) as Event);
      const dev = path.split("/").at(-2);
      expect(events.every((e) => e.author === dev)).toBe(true);
    }
    const aaaaaa = dec.decode(files[segments[0] as string]).split("\n").slice(0, -1).map((line) => JSON.parse(line) as Event);
    expect(aaaaaa).toEqual(await all(vault.events.scan({ author: "aaaaaa" })));
    const blobs = paths(files).filter((p) => p.startsWith(".estoc/blobs/"));
    expect(blobs).toEqual((await vault.blobs.list()).map((cid) => `.estoc/blobs/${cid}`));
    expect(blobs.length).toBeGreaterThan(3); // hello, and big's root and two chunks
    expect(files[`.estoc/blobs/${big}`]).toEqual(await vault.blobs.getBlock(big));
    expect(files[`.estoc/extensions/${EXT_A}/blobs/${tag}`]).toEqual(enc.encode("tag"));
    expect(paths(files).filter((p) => !p.includes("/devices/") && !p.includes("/blobs/"))).toEqual([
      ".estoc/config.json",
      ".estoc/keystore.json",
      ".estoc/state/read.json",
    ]);
  });
});

describe("round trip (event-store.md §10.1)", () => {
  it("memory → folder → memory: the same events, the same blocks, the same files", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault } = await populated(c.now);
    const files = await exportVault(vault, { clock: c.now });
    const backend = new MemoryBackend();
    expect(await restoreFolder(backend, files)).toEqual({ files: paths(files).length });
    expect([...backend.files.keys()].sort()).toEqual(paths(files));
    const folder = await FolderVault.open(backend);
    const original = await contents(vault);
    expect(await contents(folder, [folder.self])).toEqual(original);
    const back = new MemoryVault({ self: "cccccc", clock: c.now });
    const report = await importVault(back, await snapshot(backend));
    expect(report.kind).toBe("restored");
    expect(report.events["vault"]?.added).toBe(original.events["vault"]?.length as number + 1);
    expect(report.blobs.copied).toBe(Object.keys(original.blobs["vault"] ?? {}).length + 1);
    expect(await contents(back, [folder.self])).toEqual(original);
    // and memory → memory straight, which is the same import
    const direct = new MemoryVault({ self: "dddddd", clock: c.now });
    await importVault(direct, files);
    expect(await contents(direct)).toEqual(original);
  });

  it("folder → memory → folder: the same set, however the segments were chunked", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const backend = new MemoryBackend({ clock: c.now });
    const folder = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await folder.files.write("keystore.json", keystore("sealed", ["anchor"]));
    const hello = await folder.blobs.put(enc.encode("hello"));
    await folder.events.append({ type: "message.in", blobs: [hello], data: { mid: "m1" } });
    c.advance(1000);
    await folder.events.append({ type: "t", data: { n: 2 } });
    await folder.events.ingest(await foreign("bbbbbb", c.now, [{ type: "t" }]));
    await folder.extension(EXT_A).events.append({ type: "tag.added", data: {} });
    const original = await contents(folder);
    const memory = new MemoryVault({ self: "cccccc", clock: c.now });
    await importVault(memory, await snapshot(backend));
    expect(await contents(memory)).toEqual(original);
    const again = new MemoryBackend({ clock: c.now });
    await restoreFolder(again, await exportVault(memory, { clock: c.now }));
    const restored = await FolderVault.open(again, { clock: c.now });
    expect(await contents(restored, [restored.self])).toEqual(original);
    // the export chunked differently: one segment per author, not the folder's own
    expect([...again.files.keys()].filter((p) => p.includes("/devices/")).sort()).not.toEqual(
      [...backend.files.keys()].filter((p) => p.includes("/devices/")).sort()
    );
  });

  it("folder → folder merges by reading lines, never by copying a segment", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const one = new MemoryBackend();
    const a = await FolderVault.create(one, ANCHOR, { clock: c.now });
    await a.events.append({ type: "t", data: { from: "a" } });
    const two = new MemoryBackend();
    await restoreFolder(two, await snapshot(one));
    const b = await FolderVault.open(two, { clock: c.now });
    c.advance(1000);
    const later = await a.events.append({ type: "t", data: { later: true } });
    const report = await importVault(b, await snapshot(one));
    expect(report.events["vault"]).toMatchObject({ added: 1, duplicates: 2, conflicts: [], rejected: [] });
    const under = (backend: MemoryBackend): string[] => [...backend.files.keys()].filter((p) => p.startsWith(`.estoc/devices/${a.self}/`)).sort();
    expect(under(two)).toHaveLength(2); // the restored copy of a's segment, and one b minted for this ingest
    expect(under(two).filter((p) => under(one).includes(p))).toHaveLength(1);
    expect(await all(b.events.scan({ author: a.self }))).toEqual(await all(a.events.scan({ author: a.self })));
    expect(await all(b.events.scan({ data: { later: true } }))).toEqual([later]);
  });
});

describe("import: preflight (event-store.md §10.3 step 0)", () => {
  it("refuses what is not a version-2 vault, and writes nothing", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const target = await memoryVault("aaaaaa", c.now);
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const before = await contents(target);
    for (const config of [undefined, enc.encode("nope"), enc.encode(JSON.stringify({ format: "estoc", version: 1 }))]) {
      const source = { ...files };
      if (config === undefined) {
        delete source[".estoc/config.json"];
      } else {
        source[".estoc/config.json"] = config;
      }
      await expect(importVault(target, source)).rejects.toThrow(NotAVault);
    }
    expect(await contents(target)).toEqual(before);
    await expect(restoreFolder(new MemoryBackend(), { ".estoc/keystore.json": enc.encode("{}") })).rejects.toThrow(NotAVault);
  });

  it("refuses another vault's config.json, and writes nothing", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const target = await memoryVault("aaaaaa", c.now, OTHER_CONFIG);
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const before = await contents(target);
    await expect(importVault(target, files)).rejects.toThrow(NotSameVault);
    expect(await contents(target)).toEqual(before);
    expect(await target.extensions()).toEqual([]);
  });

  it("refuses a forked self found in any store, having written nothing to any", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const backend = new MemoryBackend();
    const target = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await target.extension(EXT_A).events.append({ type: "t", data: {} });
    const files = await snapshot(backend);
    // the vault store is fine: one new foreign event; the extension store has an event of self this copy never wrote
    const fresh = (await foreign("bbbbbb", c.now, [{ type: "t" }])).find((e) => e.type === "t") as Event;
    files[".estoc/devices/bbbbbb/01990000-0000-7000-8000-000000000010.jsonl"] = enc.encode(JSON.stringify(fresh) + "\n");
    const shadow: Event = { eid: "01990000-0000-7000-8000-000000000011", at: "2026-08-30T10:00:00.000Z", author: target.self, type: "t", blobs: [], data: { shadow: true } };
    files[`.estoc/extensions/${EXT_A}/devices/${target.self}/01990000-0000-7000-8000-000000000012.jsonl`] = enc.encode(JSON.stringify(shadow) + "\n");
    const before = await contents(target);
    const error = await importVault(target, files).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ForkedSelf);
    expect((error as ForkedSelf).events).toEqual([shadow]);
    expect(await contents(target)).toEqual(before);
    expect(await all(target.events.scan({ author: "bbbbbb" }))).toEqual([]);
  });

  it("refuses a keystore.json that is not one, on either side, before writing", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const target = await memoryVault("aaaaaa", c.now);
    await target.files.write("keystore.json", keystore("mine", ["anchor"]));
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const before = await contents(target);
    await expect(importVault(target, { ...files, ".estoc/keystore.json": enc.encode("[]") })).rejects.toThrow(NotAVault);
    await expect(importVault(target, { ...files, ".estoc/keystore.json": enc.encode(JSON.stringify({ keys: [{}] })) })).rejects.toThrow(NotAVault);
    expect(await contents(target)).toEqual(before);
    // the v3 shape §6.2 names, on either side: version, seed, each key's fields, names unique
    const v3 = JSON.parse(dec.decode(keystore("s", ["anchor"]))) as { keys: object[] };
    for (const doc of [
      { keys: [] },
      { ...v3, version: 2 },
      { ...v3, seedJwe: undefined },
      { ...v3, keys: [{ name: "k", did: "did:key:k" }] },
      { ...v3, keys: [...v3.keys, ...v3.keys] },
      { ...v3, keys: [{ name: "bad name", did: "did:key:k", createdAt: "2026-08-30T00:00:00.000Z" }] },
      { ...v3, keys: [{ name: "", did: "did:key:k", createdAt: "2026-08-30T00:00:00.000Z" }] },
    ]) {
      await expect(importVault(target, { ...files, ".estoc/keystore.json": enc.encode(JSON.stringify(doc)) })).rejects.toThrow(/v3 keystore/);
    }
    await target.files.write("keystore.json", enc.encode(JSON.stringify({ ...v3, keys: [...v3.keys, ...v3.keys] })));
    await expect(importVault(target, files)).rejects.toThrow(/this vault's keystore.json .*two keys/);
    expect((await contents(target)).events).toEqual(before.events);
    // and when this vault has none to union with: the source's is still read before it is copied
    const bare = await memoryVault("cccccc", c.now);
    const nothing = await contents(bare);
    await expect(importVault(bare, { ...files, ".estoc/keystore.json": enc.encode("not json") })).rejects.toThrow(NotAVault);
    await expect(importVault(bare, { ...files, ".estoc/keystore.json": enc.encode('{"keys":[]}') })).rejects.toThrow(NotAVault);
    expect(await contents(bare)).toEqual(nothing);
    expect(await bare.files.read("keystore.json")).toBeNull();
  });

  it("refuses a restore into a store that is not empty, whatever it holds", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const stale = new MemoryVault({ self: "cccccc", clock: c.now });
    await stale.events.append({ type: "stale", data: {} });
    await expect(importVault(stale, files)).rejects.toThrow(/not empty/);
    expect((await all(stale.events.scan())).map((e) => e.type)).toEqual(["stale"]);
    expect(await stale.files.read("config.json")).toBeNull();
    for (const fill of [
      async (v: MemoryVault) => v.files.write("notes.txt", enc.encode("x")),
      async (v: MemoryVault) => void (await v.blobs.put(enc.encode("x"))),
      async (v: MemoryVault) => void (await v.extension(EXT_A).events.append({ type: "t", data: {} })),
    ]) {
      const vault = new MemoryVault({ self: "cccccc", clock: c.now });
      await fill(vault);
      await expect(importVault(vault, files)).rejects.toThrow(/not empty/);
      expect(await all(vault.events.scan())).toEqual([]);
    }
  });

  it("refuses a tree no file system could hold — a file and a directory both, a file where the layout has a directory — before writing", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const target = await memoryVault("cccccc", c.now);
    await target.files.write("state/read.json", enc.encode("{}"));
    await target.files.write("notes.txt", enc.encode("mine"));
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const before = await contents(target);
    const trees: VaultFiles[] = [
      { ".estoc/a": enc.encode("x"), ".estoc/a/b": enc.encode("y") }, // within the source
      { ".estoc/devices": enc.encode("x") }, // where every store has its log
      { ".estoc/devices/aaaaaa": enc.encode("x") },
      { ".estoc/blobs": enc.encode("x") },
      { [`.estoc/extensions/${EXT_A}/devices`]: enc.encode("x") },
      { ".estoc/local": enc.encode("x") },
    ];
    for (const tree of trees) {
      await expect(importVault(target, { ...files, ...tree })).rejects.toThrow(NotAVault);
      await expect(restoreFolder(new MemoryBackend(), { ...files, ...tree })).rejects.toThrow(NotAVault);
    }
    // against what is here: a file of this vault under a path the source has a file at, and the other way round
    await expect(importVault(target, { ...files, ".estoc/state": enc.encode("x") })).rejects.toThrow(/file and a directory/);
    await expect(importVault(target, { ...files, ".estoc/notes.txt/more": enc.encode("x") })).rejects.toThrow(/file and a directory/);
    expect(await contents(target)).toEqual(before);
    expect(await target.extensions()).toEqual([]);
    // a folder no store wrote: a file of this vault's where an extension store has its directory
    const backend = new MemoryBackend();
    const hand = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await backend.write(`.estoc/extensions/${EXT_A}/devices`, enc.encode("in the way"));
    const held = new Map(backend.files);
    await expect(importVault(hand, files)).rejects.toThrow(/file where the layout has a directory/);
    expect(backend.files).toEqual(held);
    expect(await all(hand.events.scan({ author: "aaaaaa" }))).toEqual([]);
  });

  it("refuses a path no store would take, before writing: a store's refusal must not come after the events went in", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const target = await memoryVault("aaaaaa", c.now);
    const files = await exportVault(await populated(c.now).then((p) => p.vault));
    const before = await contents(target);
    for (const path of [".estoc/../bad", ".estoc/state/../read.json", ".estoc/state//read.json", ".estoc/état.json"]) {
      await expect(importVault(target, { ...files, [path]: enc.encode("x") })).rejects.toThrow(NotAVault);
      await expect(restoreFolder(new MemoryBackend(), { ...files, [path]: enc.encode("x") })).rejects.toThrow(NotAVault);
    }
    expect(await contents(target)).toEqual(before);
    expect(await target.extensions()).toEqual([]);
  });
});

describe("import: events (rule 1)", () => {
  it("ingests every line of every store, counts what is here already, reports damage and a device without its device.minted", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source } = await populated(c.now);
    const files = await exportVault(source, { clock: c.now });
    const target = await memoryVault("cccccc", c.now);
    await target.events.ingest((await all(source.events.scan())).slice(0, 2));
    const orphan = (await foreign("zzzzzz", c.now, [{ type: "t" }])).find((e) => e.type === "t") as Event; // without its device.minted
    const { eid: _eid, ...damagedEnvelope } = orphan;
    files[".estoc/devices/zzzzzz/01990000-0000-7000-8000-000000000010.jsonl"] = enc.encode(
      JSON.stringify(orphan) + "\n" + JSON.stringify(damagedEnvelope) + "\nnot json\n" + JSON.stringify({ ...orphan, author: "aaaaaa", eid: "01990000-0000-7000-8000-000000000099" }) + "\n"
    );
    const report = await importVault(target, files);
    expect(report.kind).toBe("merged");
    expect(report.events["vault"]).toMatchObject({ added: 4, duplicates: 2, conflicts: [], rejected: [] }); // 5 of the source's, 2 here already, and the orphan's
    expect(report.events[EXT_A]).toMatchObject({ added: 2, duplicates: 0 });
    expect(report.incomplete).toEqual(["zzzzzz"]);
    expect(report.damaged.map((d) => [d.where, d.error])).toEqual([
      [".estoc/devices/zzzzzz/01990000-0000-7000-8000-000000000010.jsonl:2", "eid is not a uuidv7"],
      [".estoc/devices/zzzzzz/01990000-0000-7000-8000-000000000010.jsonl:3", expect.stringMatching(/not JSON/) as string],
      [".estoc/devices/zzzzzz/01990000-0000-7000-8000-000000000010.jsonl:4", "author aaaaaa in a segment of device zzzzzz"],
    ]);
    expect(await all(target.events.scan({ author: "zzzzzz" }))).toEqual([orphan]);
    expect(await all(target.events.scan({ author: "aaaaaa" }))).toEqual(await all(source.events.scan({ author: "aaaaaa" })));
    // again: everything is a duplicate, and self's own events travel as duplicates too
    const again = await importVault(target, await exportVault(target));
    expect(again.events["vault"]).toMatchObject({ added: 0, conflicts: [] });
    expect(again.events["vault"]?.duplicates).toBe((await all(target.events.scan())).length);
  });
});

describe("import: blobs (rule 2)", () => {
  it("copies a block iff a held root reaches it and it is sound; repairs damage here; reports damage there", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source, big } = await populated(c.now);
    const orphan = await source.blobs.put(enc.encode("orphan")); // no event names it
    const files = await exportVault(source, { clock: c.now });
    const bad = (await foreign("bbbbbb", c.now, [{ type: "t", blobs: ["bafkreigl3o5l6rnjuinwyorjwbdl6xr6njkrcbe6qkhhc2ejo6cmgdvuse"] }])).find((e) => e.type === "t") as Event;
    files[".estoc/devices/bbbbbb/01990000-0000-7000-8000-000000000010.jsonl"] = enc.encode(JSON.stringify(bad) + "\n");
    files[".estoc/blobs/bafkreigl3o5l6rnjuinwyorjwbdl6xr6njkrcbe6qkhhc2ejo6cmgdvuse"] = enc.encode("not what the name says");
    const backend = new MemoryBackend();
    const target = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await backend.write(`.estoc/blobs/${HELLO_CID}`, enc.encode("damaged here"));
    const report = await importVault(target, files);
    const blocks = await target.blobs.list();
    expect(blocks).toContain(HELLO_CID);
    expect(blocks).toContain(big);
    expect(blocks).not.toContain(orphan);
    expect(blocks).not.toContain("bafkreigl3o5l6rnjuinwyorjwbdl6xr6njkrcbe6qkhhc2ejo6cmgdvuse");
    expect(await target.blobs.get(HELLO_CID)).toEqual(enc.encode("hello"));
    expect(backend.files.get(`.estoc/local/damaged/blobs/${HELLO_CID}`)).toEqual(enc.encode("damaged here"));
    expect(await target.blobs.get(big)).toEqual(bigBytes());
    expect(report.blobs.copied).toBe(5); // hello, big's root and two chunks, and the extension's
    expect(report.blobs.damaged).toEqual([{ store: "vault", cid: "bafkreigl3o5l6rnjuinwyorjwbdl6xr6njkrcbe6qkhhc2ejo6cmgdvuse", error: expect.stringMatching(/hash/) as string }]);
    expect(await target.extension(EXT_A).blobs.list()).toHaveLength(1);
    // the same again copies nothing: every block a held root reaches is here and sound
    expect((await importVault(target, files)).blobs.copied).toBe(0);
  });

  it("does not walk damage: a name over another node's bytes reaches nothing through them", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source, big } = await populated(c.now);
    const twin = bigBytes();
    twin[0] = (twin[0] as number) ^ 1;
    const other = await source.blobs.put(twin); // a dag-pb name that is not big's
    const files = await exportVault(source, { clock: c.now });
    files[`.estoc/blobs/${other}`] = files[`.estoc/blobs/${big}`] as Uint8Array; // big's root node under other's name
    const target = await memoryVault("cccccc", c.now);
    const report = await importVault(target, files, { held: (store) => (store === "vault" ? [other] : []) });
    expect(report.blobs.damaged).toEqual([{ store: "vault", cid: other, error: expect.stringMatching(/hash/) as string }]);
    expect(report.blobs.copied).toBe(0); // not big's root, and not the chunks its node links
    expect(await target.blobs.list()).toEqual([]);
  });

  it("asks the fold which roots are held, and copies only what those reach", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source, big } = await populated(c.now);
    const files = await exportVault(source, { clock: c.now });
    const target = await memoryVault("cccccc", c.now);
    const asked: string[] = [];
    const report = await importVault(target, files, {
      held: (store, events) => {
        asked.push(store);
        expect(events.every((e) => isUuidv7(e.eid))).toBe(true);
        return store === "vault" ? [HELLO_CID] : []; // as if `big` were erased, and the extension's blob too
      },
    });
    expect(asked).toEqual(["vault", EXT_A]);
    expect(await target.blobs.list()).toEqual([HELLO_CID]);
    expect(await target.blobs.has(big)).toBe(false);
    expect(await target.extension(EXT_A).blobs.list()).toEqual([]);
    expect(report.blobs.copied).toBe(1);
  });
});

describe("import: files (rule 3)", () => {
  it("leaves config.json, unions the key cache by name over this seed, copies unknown paths when absent, never overwrites, never touches local/", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source } = await populated(c.now);
    await source.files.write("keystore.json", keystore("sealed-theirs", ["k1", "k2"]));
    await source.files.write("state/y.json", enc.encode("theirs"));
    await source.files.write("notes.txt", enc.encode("carried"));
    await source.files.write("devices/aaaaaa/readme.txt", enc.encode("a file where segments live"));
    await source.files.write("blobs/not-a-cid", enc.encode("a file where blocks live"));
    const files = await exportVault(source, { clock: c.now });
    files[".estoc/local/agent/options.json"] = enc.encode("{}");
    files[".estoc/local/self.json"] = enc.encode(JSON.stringify({ dev: "aaaaaa", instance: "i" }));
    const backend = new MemoryBackend();
    const target = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await target.files.write("keystore.json", keystore("sealed-mine", ["anchor", "k1"]));
    await target.files.write("state/y.json", enc.encode("mine"));
    const report = await importVault(target, files);
    expect(report.files).toEqual({ copied: ["blobs/not-a-cid", "devices/aaaaaa/readme.txt", "notes.txt", "state/read.json"], keysAdded: 1 });
    expect(JSON.parse(dec.decode((await target.files.read("keystore.json")) as Uint8Array))).toEqual({
      version: 3,
      seedJwe: "sealed-mine",
      keys: ["anchor", "k1", "k2"].map((name) => ({ name, did: `did:key:${name}`, createdAt: "2026-08-30T00:00:00.000Z" })),
    });
    expect(dec.decode((await target.files.read("state/y.json")) as Uint8Array)).toBe("mine");
    expect(dec.decode((await target.files.read("state/read.json")) as Uint8Array)).toBe("{}");
    expect(backend.files.get(".estoc/config.json")).toEqual(files[".estoc/config.json"]);
    expect(backend.files.has(".estoc/local/agent/options.json")).toBe(false);
    expect(JSON.parse(dec.decode(backend.files.get(".estoc/local/self.json"))).dev).toBe(target.self);
    expect(await target.files.list()).toEqual(["blobs/not-a-cid", "config.json", "devices/aaaaaa/readme.txt", "keystore.json", "notes.txt", "state/read.json", "state/y.json"]);
  });

  it("copies keystore.json whole when this vault has none", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source } = await populated(c.now);
    const target = await memoryVault("cccccc", c.now);
    const report = await importVault(target, await exportVault(source));
    expect(report.files.copied).toContain("keystore.json");
    expect(report.files.keysAdded).toBe(0);
    expect(await target.files.read("keystore.json")).toEqual(await source.files.read("keystore.json"));
  });
});

describe("import: extension stores", () => {
  it("merges each into the store of the same ext, drops what the fold says is purged, reports what it cannot account for", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const { vault: source } = await populated(c.now);
    await source.extension(EXT_B).events.append({ type: "gone", data: {} });
    await source.extension(EXT_C).events.append({ type: "unaccounted", data: {} });
    const files = await exportVault(source, { clock: c.now });
    files[`.estoc/extensions/${EXT_B}/readme.txt`] = enc.encode("a file under a purged store");
    files[`.estoc/extensions/${EXT_A}/readme.txt`] = enc.encode("a file under a kept one");
    const target = await memoryVault("cccccc", c.now);
    await target.files.write(`extensions/${EXT_B}/readme.txt/child`, enc.encode("a purged store's file is not written, so it cannot clash")); 
    const seen: Event[][] = [];
    const report = await importVault(target, files, {
      purged: (events) => {
        seen.push(events);
        return [EXT_B];
      },
      installed: () => [EXT_A],
    });
    expect(report.purged).toEqual([EXT_B]);
    expect(report.unaccounted).toEqual([EXT_C]);
    expect(Object.keys(report.events)).toEqual(["vault", EXT_A, EXT_C]);
    expect(await target.extensions()).toEqual([EXT_A, EXT_C]);
    expect(await all(target.extension(EXT_A).events.scan())).toEqual(await all(source.extension(EXT_A).events.scan()));
    expect(await target.files.list()).toEqual(["config.json", `extensions/${EXT_A}/readme.txt`, `extensions/${EXT_B}/readme.txt/child`, "keystore.json", "state/read.json"]);
    // the fold was asked over the merged vault set: the source's events were in it, not only this store's
    expect(seen).toHaveLength(1);
    expect(seen[0]?.some((e) => e.type === "message.in")).toBe(true);
    expect(seen[0]?.some((e) => e.author === "cccccc")).toBe(true);
  });
});

describe("restore", () => {
  it("copies the snapshot as it is into an empty backend, config.json last, and the next open writes as a new device", async () => {
    const c = clock("2026-08-30T10:00:00.000Z");
    const backend = new MemoryBackend();
    const vault = await FolderVault.create(backend, ANCHOR, { clock: c.now });
    await vault.events.append({ type: "t", data: {} });
    await vault.local("agent").writeOptions({ trace: "normal" });
    const files = await snapshot(backend);
    files[".estoc/local/agent/options.json"] = enc.encode("{}"); // a zip made by hand
    const order: string[] = [];
    class Spied extends MemoryBackend {
      override async write(path: string, data: Uint8Array): Promise<void> {
        order.push(path);
        return super.write(path, data);
      }
    }
    const fresh = new Spied();
    expect(await restoreFolder(fresh, files)).toEqual({ files: 2 }); // config.json and one segment; local/ stays out
    expect(order.at(-1)).toBe(".estoc/config.json");
    expect([...fresh.files.keys()].sort()).toEqual(paths(files).filter((p) => !p.startsWith(".estoc/local/")));
    await expect(restoreFolder(fresh, files)).rejects.toThrow(NotAVault);
    // not only a vault: anything at .estoc is something the copy would be mixed into — a file, an empty directory
    const stale = new MemoryBackend();
    await stale.write(".estoc/stale.txt", enc.encode("left over"));
    await expect(restoreFolder(stale, files)).rejects.toThrow(/not empty/);
    expect([...stale.files.keys()]).toEqual([".estoc/stale.txt"]);
    class EmptyDir extends MemoryBackend {
      override async dirs(dir: string): Promise<string[]> {
        return dir === ".estoc" ? ["config.json"] : super.dirs(dir);
      }
    }
    const hollow = new EmptyDir();
    await expect(restoreFolder(hollow, files)).rejects.toThrow(/not empty/);
    expect(hollow.files.size).toBe(0);
    const file = new MemoryBackend();
    await file.write(".estoc", enc.encode("a file"));
    await expect(restoreFolder(file, files)).rejects.toThrow(/not empty/);
    const restored = await FolderVault.open(fresh);
    expect(restored.self).not.toBe(vault.self);
    expect((await all(restored.events.scan({ type: DEVICE_MINTED }))).map((e) => e.author).sort()).toEqual([vault.self, restored.self].sort());
    expect(await all(restored.events.scan({ author: vault.self }))).toEqual(await all(vault.events.scan({ author: vault.self })));
  });
});
