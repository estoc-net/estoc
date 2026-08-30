import { describe, expect, it } from "vitest";

import { DEVICE_MINTED, Disposed, FolderVault, MemoryBackend, NotAVault, isDeviceId, mintDeviceId } from "../src/index.js";
import { HELLO_CID } from "./suite/blob-suite.js";
import { all } from "./suite/helpers.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const EXT = "01990000-0000-7000-8000-0000000000ee";
const ANCHOR = { identity: { anchor: { key: "anchor", did: "did:key:z6MkTest" } } };

async function fresh(): Promise<{ backend: MemoryBackend; vault: FolderVault }> {
  const backend = new MemoryBackend();
  return { backend, vault: await FolderVault.create(backend, ANCHOR) };
}

describe("vault: config.json", () => {
  it("is written once, pretty, with the format and version first", async () => {
    const { backend } = await fresh();
    expect(dec.decode(backend.files.get(".estoc/config.json"))).toBe(
      JSON.stringify({ format: "estoc", version: 2, ...ANCHOR }, null, 2) + "\n"
    );
    await expect(FolderVault.create(backend, ANCHOR)).rejects.toThrow(NotAVault);
    await expect(FolderVault.create(new MemoryBackend(), { version: 2 })).rejects.toThrow(NotAVault);
  });

  it("is refused unless it says estoc, version 2 — and nothing else is read or written", async () => {
    for (const config of [
      undefined,
      "not json",
      "[]",
      JSON.stringify({ format: "estoc", version: 1 }),
      JSON.stringify({ format: "estoc", version: "2" }),
      JSON.stringify({ format: "other", version: 2 }),
      JSON.stringify({ version: 2 }),
    ]) {
      const backend = new MemoryBackend();
      if (config !== undefined) {
        await backend.write(".estoc/config.json", enc.encode(config));
      }
      await expect(FolderVault.open(backend), String(config)).rejects.toThrow(NotAVault);
      expect([...backend.files.keys()], String(config)).toEqual(config === undefined ? [] : [".estoc/config.json"]);
    }
  });
});

describe("vault: this copy", () => {
  it("mints local/self.json on first open and announces the device once", async () => {
    const { backend, vault } = await fresh();
    const self = JSON.parse(dec.decode(backend.files.get(".estoc/local/self.json"))) as { dev: string; instance: string };
    expect(isDeviceId(self.dev)).toBe(true);
    expect(self.instance).toMatch(/^[0-9a-f-]{36}$/);
    expect(vault.self).toBe(self.dev);
    expect(vault.events.self).toBe(self.dev);
    const minted = await all(vault.events.scan({ type: DEVICE_MINTED }));
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({ author: self.dev, type: DEVICE_MINTED, blobs: [], data: {} });
    // reopen: same device, same instance, no second announcement
    const again = await FolderVault.open(backend);
    expect(again.self).toBe(self.dev);
    expect(again.instance).toBe(self.instance);
    expect(await all(again.events.scan({ type: DEVICE_MINTED }))).toHaveLength(1);
  });

  it("fills the gap a crash between self.json and the first append leaves", async () => {
    const backend = new MemoryBackend();
    await backend.write(".estoc/config.json", enc.encode(JSON.stringify({ format: "estoc", version: 2 })));
    await backend.write(".estoc/local/self.json", enc.encode(JSON.stringify({ dev: "k7q3ma", instance: "i-1" })));
    const vault = await FolderVault.open(backend);
    expect(vault.self).toBe("k7q3ma");
    expect(vault.instance).toBe("i-1");
    expect(await all(vault.events.scan({ author: "k7q3ma", type: DEVICE_MINTED }))).toHaveLength(1);
    for (const bad of ["{}", JSON.stringify({ dev: "K7Q3MA", instance: "i" }), JSON.stringify({ dev: "k7q3ma" }), "nope"]) {
      await backend.write(".estoc/local/self.json", enc.encode(bad));
      await expect(FolderVault.open(backend), bad).rejects.toThrow(NotAVault);
    }
  });

  it("keeps a restored copy's old devices as history and writes as a new one", async () => {
    const { backend, vault } = await fresh();
    await vault.events.append({ type: "t", data: {} });
    const copy = new MemoryBackend();
    for (const [path, bytes] of backend.files) {
      if (!path.startsWith(".estoc/local/")) {
        await copy.write(path, bytes);
      }
    }
    const restored = await FolderVault.open(copy);
    expect(restored.self).not.toBe(vault.self);
    const minted = await all(restored.events.scan({ type: DEVICE_MINTED }));
    expect(minted.map((e) => e.author).sort()).toEqual([vault.self, restored.self].sort());
    expect(await all(restored.events.scan())).toHaveLength(3);
  });

  it("keeps a named owner's local state under local/<owner>/, out of the files", async () => {
    const { backend, vault } = await fresh();
    const agent = vault.local("agent");
    expect(await agent.readOptions()).toBeNull();
    await agent.writeOptions({ trace: "normal" });
    expect(await agent.readOptions()).toEqual({ trace: "normal" });
    expect(dec.decode(backend.files.get(".estoc/local/agent/options.json"))).toBe('{\n  "trace": "normal"\n}\n');
    await agent.cache.write("folds/contacts.json", enc.encode("{}"));
    await agent.cache.write("index", enc.encode("x"));
    expect(await agent.cache.list()).toEqual(["folds/contacts.json", "index"]);
    expect(await agent.cache.read("index")).toEqual(enc.encode("x"));
    await agent.cache.remove("index");
    expect(await agent.cache.list()).toEqual(["folds/contacts.json"]);
    await agent.cache.clear();
    expect(await agent.cache.list()).toEqual([]);
    await agent.trace("wire").append({ eid: "01990000-0000-7000-8000-000000000001", at: "2026-08-30T10:00:00Z", type: "wire.out", data: {} });
    expect([...backend.files.keys()].filter((p) => p.startsWith(".estoc/local/agent/trace/wire/"))).toHaveLength(1);
    expect(await vault.files.list()).toEqual(["config.json"]);
    expect(vault.local("agent")).toBe(agent);
    for (const bad of ["self.json", "extensions", "damaged", "Agent", "a/b", ""]) {
      expect(() => vault.local(bad), bad).toThrow();
    }
  });
});

describe("vault: extension stores", () => {
  it("hands out a handle whose bytes appear at the first write, under extensions/<ext>/", async () => {
    const { backend, vault } = await fresh();
    expect(() => vault.extension("onion")).toThrow(/extension id/);
    const ext = vault.extension(EXT);
    expect(vault.extension(EXT)).toBe(ext);
    expect(await vault.extensions()).toEqual([]);
    expect(ext.events.self).toBe(vault.self);
    expect(await all(ext.events.scan())).toEqual([]); // no device.minted of its own
    const e = await ext.events.append({ type: "tag.added", data: { mid: "x" } });
    expect(await vault.extensions()).toEqual([EXT]);
    const paths = [...backend.files.keys()].filter((p) => p.startsWith(`.estoc/extensions/${EXT}/`));
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(new RegExp(`^\\.estoc/extensions/${EXT}/devices/${vault.self}/[0-9a-f-]+\\.jsonl$`));
    expect(await ext.blobs.put(enc.encode("hello"))).toBe(HELLO_CID);
    expect(backend.files.has(`.estoc/extensions/${EXT}/blobs/${HELLO_CID}`)).toBe(true);
    // the two sets are two sets
    expect(await all(vault.events.scan({ type: "tag.added" }))).toEqual([]);
    expect(await vault.blobs.has(HELLO_CID)).toBe(false);
    expect(await all(ext.events.scan())).toEqual([e]);
    // tokens are per store
    const token = (await vault.events.changes()).token;
    await expect(ext.events.changes(undefined, token)).rejects.toThrow(/instance/);
  });

  it("lists an extension with a blob and no segment, and not a directory with neither", async () => {
    const { backend, vault } = await fresh();
    const other = "01990000-0000-7000-8000-0000000000ff";
    await vault.extension(other).blobs.put(enc.encode("hello"));
    await backend.write(`.estoc/extensions/${EXT}/notes.txt`, enc.encode("x"));
    await backend.write(".estoc/extensions/onion/devices/k7q3ma/01990000-0000-7000-8000-000000000010.jsonl", enc.encode(""));
    expect(await vault.extensions()).toEqual([other]);
  });

  it("dispose removes the store and its local state whole, and every handle is dead from then on", async () => {
    const { backend, vault } = await fresh();
    const ext = vault.extension(EXT);
    await ext.events.append({ type: "t", data: {} });
    await ext.blobs.put(enc.encode("hello"));
    await ext.local.writeOptions({ run: true });
    await ext.local.cache.write("f", enc.encode("x"));
    const trace = ext.local.trace("diag");
    await trace.append({ eid: "01990000-0000-7000-8000-000000000001", at: "2026-08-30T10:00:00Z", type: "note", data: {} });
    await backend.write(`.estoc/extensions/${EXT}/readme.txt`, enc.encode("carried"));
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`)).length).toBeGreaterThanOrEqual(6);
    // an operation in flight finishes before the removal; one issued after the call does not begin
    const inFlight = ext.events.append({ type: "t", data: { last: true } });
    const inFlightTrace = trace.append({ eid: "01990000-0000-7000-8000-000000000003", at: "2026-08-30T10:00:00Z", type: "note", data: {} });
    const disposal = vault.dispose(EXT);
    const after = ext.events.append({ type: "t", data: { late: true } });
    await disposal;
    await expect(inFlight).resolves.toMatchObject({ type: "t" });
    await expect(inFlightTrace).resolves.toBeUndefined();
    await expect(after).rejects.toThrow(Disposed);
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`))).toEqual([]);
    expect(await vault.extensions()).toEqual([]);
    expect(() => vault.extension(EXT)).toThrow(Disposed);
    await expect(ext.events.append({ type: "t", data: {} })).rejects.toThrow(Disposed);
    await expect(all(ext.events.scan())).rejects.toThrow(Disposed);
    await expect(ext.events.ingest([])).rejects.toThrow(Disposed);
    await expect(ext.events.changes()).rejects.toThrow(Disposed);
    expect(() => ext.events.damaged()).toThrow(Disposed);
    expect(() => ext.events.conflicting()).toThrow(Disposed);
    await expect(ext.blobs.put(enc.encode("x"))).rejects.toThrow(Disposed);
    await expect(ext.blobs.get(HELLO_CID)).rejects.toThrow(Disposed);
    await expect(ext.blobs.getBlock(HELLO_CID)).rejects.toThrow(Disposed);
    await expect(ext.blobs.has(HELLO_CID)).rejects.toThrow(Disposed);
    await expect(ext.blobs.list()).rejects.toThrow(Disposed);
    await expect(ext.blobs.collect([])).rejects.toThrow(Disposed);
    await expect(ext.blobs.putBlock(HELLO_CID, enc.encode("hello"))).rejects.toThrow(Disposed);
    await expect(ext.local.readOptions()).rejects.toThrow(Disposed);
    await expect(ext.local.writeOptions({})).rejects.toThrow(Disposed);
    expect(() => ext.local.cache).toThrow(Disposed);
    expect(() => ext.local.trace("diag")).toThrow(Disposed);
    await expect(trace.append({ eid: "01990000-0000-7000-8000-000000000002", at: "2026-08-30T10:00:00Z", type: "note", data: {} })).rejects.toThrow(Disposed);
    await expect(all(trace.scan())).rejects.toThrow(Disposed);
    await expect(trace.prune({ keepMs: 0, capBytes: 0 })).rejects.toThrow(Disposed);
    expect(() => trace.damaged()).toThrow(Disposed);
    // the vault's own store is untouched
    expect(await all(vault.events.scan())).toHaveLength(1);
    // disposing what was never opened removes what is on disk all the same
    const other = "01990000-0000-7000-8000-0000000000ff";
    await backend.write(`.estoc/extensions/${other}/blobs/${HELLO_CID}`, enc.encode("hello"));
    await backend.write(`.estoc/local/extensions/${other}/options.json`, enc.encode("{}"));
    await vault.dispose(other);
    expect([...backend.files.keys()].filter((p) => p.includes(`/${other}/`))).toEqual([]);
    expect(() => vault.extension(other)).toThrow(Disposed);
  });

  it("lets an operation in flight — a write or a read — finish before the removal, never after it", async () => {
    // a backend whose reads and writes wait for a gate: the operation has passed the guard, the bytes are not moved yet
    class GatedBackend extends MemoryBackend {
      gate: Promise<void> = Promise.resolve();
      override async write(path: string, data: Uint8Array): Promise<void> {
        await this.gate;
        return super.write(path, data);
      }
      override async read(path: string): Promise<Uint8Array | null> {
        await this.gate;
        return super.read(path);
      }
    }
    const backend = new GatedBackend();
    const vault = await FolderVault.create(backend, ANCHOR);
    const ext = vault.extension(EXT);
    const event = await ext.events.append({ type: "t", data: {} });
    await ext.local.writeOptions({ run: true });
    const cache = ext.local.cache;
    await cache.write("f", enc.encode("x"));
    const trace = ext.local.trace("diag");
    const note = { eid: "01990000-0000-7000-8000-000000000001", at: "2026-08-30T10:00:00Z", type: "note", data: {} };
    await trace.append(note);
    let release = (): void => undefined;
    backend.gate = new Promise((resolve) => {
      release = resolve;
    });
    const options = ext.local.writeOptions({ late: true });
    const cached = cache.write("g", enc.encode("y"));
    const readOptions = ext.local.readOptions();
    const readCache = cache.read("f");
    const listCache = cache.list();
    const scan = all(ext.events.scan());
    const changes = ext.events.changes();
    const traced = all(trace.scan());
    const disposal = vault.dispose(EXT);
    release();
    await Promise.all([options, cached, disposal]);
    // every read in flight saw the store as it was — after the writes queued before it, before the emptied tree
    expect(await readOptions).toEqual({ late: true });
    expect(await readCache).toEqual(enc.encode("x"));
    expect(await listCache).toEqual(["f", "g"]);
    expect(await scan).toEqual([event]);
    expect(await all((await changes).events)).toEqual([event]);
    expect(await traced).toEqual([note]);
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`))).toEqual([]);
    // a handle taken before the call is dead like the rest
    await expect(cache.write("g", enc.encode("y"))).rejects.toThrow(Disposed);
    await expect(cache.remove("f")).rejects.toThrow(Disposed);
    await expect(cache.clear()).rejects.toThrow(Disposed);
  });

  it("lets an ingest that has its turn finish, however slow the store's reads, before the removal", async () => {
    class GatedBackend extends MemoryBackend {
      gate: Promise<void> = Promise.resolve();
      override async read(path: string): Promise<Uint8Array | null> {
        await this.gate;
        return super.read(path);
      }
    }
    const backend = new GatedBackend();
    const vault = await FolderVault.create(backend, ANCHOR);
    const ext = vault.extension(EXT);
    await ext.events.append({ type: "t", data: {} });
    let release = (): void => undefined;
    backend.gate = new Promise((resolve) => {
      release = resolve;
    });
    const foreign = { eid: "01990000-0000-7000-8000-000000000001", at: "2026-08-30T10:00:00Z", author: "aaaaaa", type: "t", blobs: [], data: {} };
    const ingest = ext.events.ingest([foreign]);
    await new Promise((resolve) => setTimeout(resolve, 0)); // the input is read; the store's turn is taken, its reads held
    const disposal = vault.dispose(EXT);
    release();
    expect(await ingest).toMatchObject({ added: 1 });
    await disposal;
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`))).toEqual([]);
  });

  it("does not wait on an ingest still reading its input: that one is refused when its turn comes, having written nothing", async () => {
    const { backend, vault } = await fresh();
    const ext = vault.extension(EXT);
    await ext.events.append({ type: "t", data: {} });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* input(): AsyncIterable<unknown> {
      await gate;
      yield { eid: "01990000-0000-7000-8000-000000000001", at: "2026-08-30T10:00:00Z", author: "aaaaaa", type: "t", blobs: [], data: {} };
    }
    const ingest = ext.events.ingest(input());
    await vault.dispose(EXT); // resolves while the input is still held
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`))).toEqual([]);
    release();
    await expect(ingest).rejects.toThrow(Disposed);
    expect([...backend.files.keys()].filter((p) => p.includes(`/${EXT}/`))).toEqual([]);
  });

  it("is forgotten by the next instance: a disposed ext may be opened again there", async () => {
    const { backend, vault } = await fresh();
    await vault.extension(EXT).events.append({ type: "t", data: {} });
    await vault.dispose(EXT);
    const again = await FolderVault.open(backend);
    expect(await all(again.extension(EXT).events.scan())).toEqual([]);
  });
});

describe("vault: a device id is what self says", () => {
  it("writes as the device in self.json, whatever else is under devices/", async () => {
    const backend = new MemoryBackend();
    const other = mintDeviceId();
    await backend.write(".estoc/config.json", enc.encode(JSON.stringify({ format: "estoc", version: 2 })));
    await backend.write(`.estoc/devices/${other}/01990000-0000-7000-8000-000000000010.jsonl`, enc.encode(""));
    const vault = await FolderVault.create(new MemoryBackend(), {});
    expect(vault.self).not.toBe(other);
  });
});
