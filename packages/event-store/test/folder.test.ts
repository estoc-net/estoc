import { describe, expect, it } from "vitest";

import {
  BadToken,
  FolderFileStore,
  MemoryBackend,
  folderStore,
  isSegmentName,
  kindOf,
  mintDeviceId,
  type Event,
  type VaultBackend,
} from "../src/index.js";
import { HELLO_CID, bigBytes, blobSuite } from "./suite/blob-suite.js";
import { all, clock } from "./suite/helpers.js";
import { storeSuite } from "./suite/store-suite.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const HOUR = 60 * 60 * 1000;

storeSuite("folder over memory", async (options) => {
  const backend = new MemoryBackend(options?.clock === undefined ? {} : { clock: options.clock });
  return folderStore(backend, options ?? {}).events;
});
blobSuite("folder over memory", async (options) => {
  const backend = new MemoryBackend(options?.clock === undefined ? {} : { clock: options.clock });
  return folderStore(backend, options ?? {}).blobs;
});

/** A backend that remembers which paths were read, for tests of what a scan touches. */
function spied(backend: VaultBackend): VaultBackend & { reads: string[] } {
  const reads: string[] = [];
  return {
    ...backend,
    reads,
    read: (path) => {
      reads.push(path);
      return backend.read(path);
    },
    list: (dir) => backend.list(dir),
    dirs: (dir) => backend.dirs(dir),
    write: (path, data) => backend.write(path, data),
    append: (path, data) => backend.append(path, data),
    remove: (path) => backend.remove(path),
    size: (path) => backend.size(path),
    modified: (path) => backend.modified(path),
  };
}

function open(options: { self?: string; clock?: () => Date; graceMs?: number; rotateBytes?: number } = {}) {
  const backend = new MemoryBackend(options.clock === undefined ? {} : { clock: options.clock });
  const store = folderStore(backend, options);
  return { backend, ...store };
}

/** The segment files under `devices/<dev>/`, by path. */
function segmentsOf(backend: MemoryBackend, dev: string): string[] {
  return [...backend.files.keys()].filter((p) => p.startsWith(`.estoc/devices/${dev}/`) && isSegmentName(p.split("/").at(-1) as string)).sort();
}

function fileText(backend: MemoryBackend, path: string): string {
  return dec.decode(backend.files.get(path));
}

/** An event as another device would have written it, for hand-made segments. */
function foreign(author: string, eid: string, at: string, data: Record<string, string> = {}): Event {
  return { eid, at, author, type: "t", blobs: [], data };
}

describe("folder: the log on disk", () => {
  it("writes one line per event, whole, under devices/<self>/<uuidv7>.jsonl", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const a = await events.append({ type: "t", data: { n: 1 } });
    const b = await events.append({ type: "t", data: { n: 2 } });
    const segments = segmentsOf(backend, "k7q3ma");
    expect(segments).toHaveLength(1);
    expect(kindOf((segments[0] as string).slice(".estoc/".length))).toBe("segment");
    const lines = fileText(backend, segments[0] as string).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0] as string)).toEqual(a);
    expect(JSON.parse(lines[1] as string)).toEqual(b);
    expect(lines[0]).not.toContain("\n");
    expect(lines[0]).not.toContain(": "); // compact
  });

  it("carries on in the newest segment of its device across instances", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    await events.append({ type: "t", data: {} });
    const again = folderStore(backend, { self: "k7q3ma" }).events;
    await again.append({ type: "t", data: {} });
    expect(segmentsOf(backend, "k7q3ma")).toHaveLength(1);
    expect(await all(again.scan())).toHaveLength(2);
  });

  it("rotates to a fresh segment once the open one is long enough", async () => {
    const { backend, events } = open({ self: "k7q3ma", rotateBytes: 300 });
    for (let i = 0; i < 6; i++) {
      await events.append({ type: "t", data: { i } });
    }
    expect(segmentsOf(backend, "k7q3ma").length).toBeGreaterThan(1);
    expect(await all(events.scan())).toHaveLength(6);
  });

  it("heals a fragment a crash left before its first append, and reports it damaged", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const { backend, events } = open({ self: "k7q3ma", clock: c.now });
    await events.append({ type: "t", data: { n: 1 } });
    const path = segmentsOf(backend, "k7q3ma")[0] as string;
    await backend.append(path, enc.encode('{"eid":"0199')); // the process died mid-append
    c.advance(1000);
    const next = folderStore(backend, { self: "k7q3ma", clock: c.now }).events;
    await next.append({ type: "t", data: { n: 2 } });
    const text = fileText(backend, path);
    expect(text).toMatch(/\n\{"eid":"0199\n\{"eid"/);
    const scanned = await all(next.scan());
    expect(scanned.map((e) => e.data["n"])).toEqual([1, 2]);
    expect(next.damaged()).toEqual([{ where: `${path}:2`, line: '{"eid":"0199', error: expect.stringMatching(/not JSON/) }]);
    expect(segmentsOf(backend, "k7q3ma")).toEqual([path]);
  });

  it("reports an unterminated last line as damaged and never fuses it", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const e = await events.append({ type: "t", data: {} });
    const path = segmentsOf(backend, "k7q3ma")[0] as string;
    await backend.append(path, enc.encode(JSON.stringify({ ...e, eid: "01990000-0000-7000-8000-000000000001" })));
    expect(await all(events.scan())).toHaveLength(1);
    expect(events.damaged()).toEqual([{ where: `${path}:2`, line: expect.stringContaining("01990000"), error: "unterminated line" }]);
  });

  it("refuses a line whose author is not its directory", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const path = ".estoc/devices/aaaaaa/01990000-0000-7000-8000-000000000010.jsonl";
    await backend.write(path, enc.encode(JSON.stringify(foreign("bbbbbb", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z")) + "\n"));
    expect(await all(events.scan())).toEqual([]);
    expect(events.damaged()).toEqual([{ where: `${path}:1`, line: expect.any(String), error: "author bbbbbb in a segment of device aaaaaa" }]);
  });

  it("is a file, not a segment, when the name is not a device id or a segment name", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const line = JSON.stringify(foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z")) + "\n";
    await backend.write(".estoc/devices/AAAAAA/01990000-0000-7000-8000-000000000010.jsonl", enc.encode(line));
    await backend.write(".estoc/devices/aaaaaa/notes.txt", enc.encode(line));
    await backend.write(".estoc/devices/aaaaaa/0199.jsonl", enc.encode(line));
    expect(await all(events.scan())).toEqual([]);
    expect(events.damaged()).toEqual([]);
    const files = new FolderFileStore(backend, ".estoc");
    expect(await files.list()).toEqual(["devices/AAAAAA/01990000-0000-7000-8000-000000000010.jsonl", "devices/aaaaaa/0199.jsonl", "devices/aaaaaa/notes.txt"]);
  });

  it("keeps the first by path order then line order on a hand-made conflict, and reports the rest", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const eid = "01990000-0000-7000-8000-000000000001";
    const first = foreign("aaaaaa", eid, "2026-08-30T10:00:00Z", { v: "first" });
    const second = foreign("aaaaaa", eid, "2026-08-30T10:00:00Z", { v: "second" });
    const third = foreign("aaaaaa", eid, "2026-08-30T10:00:00Z", { v: "third" });
    const same = foreign("aaaaaa", eid, "2026-08-30T10:00:00Z", { v: "first" });
    await backend.write(
      ".estoc/devices/aaaaaa/01990000-0000-7000-8000-000000000010.jsonl",
      enc.encode([first, second].map((e) => JSON.stringify(e)).join("\n") + "\n")
    );
    await backend.write(".estoc/devices/aaaaaa/01990000-0000-7000-8000-000000000020.jsonl", enc.encode(JSON.stringify(third) + "\n" + JSON.stringify(same) + "\n"));
    const scanned = await all(events.scan());
    expect(scanned).toEqual([first]);
    expect(events.conflicting()).toEqual([
      { eid, kept: first, other: second },
      { eid, kept: first, other: third },
    ]);
    // a twin of the kept line is a duplicate, not a conflict
    expect(events.conflicting()).toHaveLength(2);
  });

  it("reads the folder every time: a segment dropped in by hand is seen by the next scan", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    expect(await all(events.scan())).toEqual([]);
    const e = foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z");
    await backend.write(".estoc/devices/aaaaaa/01990000-0000-7000-8000-000000000010.jsonl", enc.encode(JSON.stringify(e) + "\n"));
    expect(await all(events.scan())).toEqual([e]);
  });

  it("reads one device's directory alone when the filter names an author", async () => {
    const backend = spied(new MemoryBackend());
    const store = folderStore(backend, { self: "k7q3ma" });
    await store.events.append({ type: "t", data: {} });
    await store.events.ingest([foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z")]);
    backend.reads.length = 0;
    expect(await all(store.events.scan({ author: "aaaaaa" }))).toHaveLength(1);
    expect(backend.reads.every((p) => p.startsWith(".estoc/devices/aaaaaa/"))).toBe(true);
    backend.reads.length = 0;
    expect(await all(store.events.scan({ author: "not-a-device" }))).toEqual([]);
    expect(backend.reads).toEqual([]);
  });
});

describe("folder: ingest", () => {
  it("writes one segment per author per call, under that author, and never into a segment it did not mint", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const a1 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z");
    const a2 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000002", "2026-08-30T10:00:01Z");
    const b1 = foreign("bbbbbb", "01990000-0000-7000-8000-000000000003", "2026-08-30T10:00:02Z");
    expect(await events.ingest([a1, b1, a2])).toEqual({ added: 3, duplicates: 0, conflicts: [], rejected: [] });
    const aSegments = segmentsOf(backend, "aaaaaa");
    const bSegments = segmentsOf(backend, "bbbbbb");
    expect(aSegments).toHaveLength(1);
    expect(bSegments).toHaveLength(1);
    expect(fileText(backend, aSegments[0] as string)).toBe(JSON.stringify(a1) + "\n" + JSON.stringify(a2) + "\n");
    // another call, another segment; the first is untouched
    const a3 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000004", "2026-08-30T10:00:03Z");
    expect(await events.ingest([a1, a3])).toEqual({ added: 1, duplicates: 1, conflicts: [], rejected: [] });
    expect(segmentsOf(backend, "aaaaaa")).toHaveLength(2);
    expect(fileText(backend, aSegments[0] as string)).toBe(JSON.stringify(a1) + "\n" + JSON.stringify(a2) + "\n");
    expect(segmentsOf(backend, "k7q3ma")).toEqual([]);
    expect((await all(events.scan())).map((e) => e.eid)).toEqual([a1, a2, b1, a3].map((e) => e.eid));
  });

  it("holds an eid once when two calls in flight bring it under two authors", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const eid = "01990000-0000-7000-8000-000000000001";
    const a = foreign("aaaaaa", eid, "2026-08-30T10:00:00Z", { from: "a" });
    const b = foreign("bbbbbb", eid, "2026-08-30T10:00:00Z", { from: "b" });
    // each call reads the store in its own turn: the second's check sees the first's write
    const [first, second] = await Promise.all([events.ingest([a]), events.ingest([b])]);
    expect(first).toEqual({ added: 1, duplicates: 0, conflicts: [], rejected: [] });
    expect(second).toEqual({ added: 0, duplicates: 0, conflicts: [{ eid, kept: a, other: b }], rejected: [] });
    expect(segmentsOf(backend, "aaaaaa")).toHaveLength(1);
    expect(segmentsOf(backend, "bbbbbb")).toHaveLength(0);
    expect(await all(events.scan())).toEqual([a]);
    expect(events.conflicting()).toEqual([]);
    // the same with one call in flight over an append of self: what self wrote meanwhile is not lost sight of
    const store2 = open({ self: "aaaaaa" });
    const pending = store2.events.ingest([foreign("bbbbbb", "01990000-0000-7000-8000-000000000002", "2026-08-30T10:00:01Z")]);
    const own = await store2.events.append({ type: "t", data: {} });
    expect((await pending).added).toBe(1);
    expect((await all(store2.events.scan())).map((e) => e.eid)).toEqual([own.eid, "01990000-0000-7000-8000-000000000002"].sort());
  });

  it("writes nothing for a call that only repeats what is here", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const a1 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z");
    await events.ingest([a1]);
    const before = [...backend.files.keys()].sort();
    expect(await events.ingest([a1])).toEqual({ added: 0, duplicates: 1, conflicts: [], rejected: [] });
    expect([...backend.files.keys()].sort()).toEqual(before);
  });
});

describe("folder: changes", () => {
  it("issues a token naming the instance, the store and every segment's length", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    await events.append({ type: "t", data: {} });
    const { token } = await events.changes();
    const parsed = JSON.parse(token) as { instance: string; store: string; segments: Record<string, number> };
    expect(parsed.store).toBe("vault");
    expect(typeof parsed.instance).toBe("string");
    const path = segmentsOf(backend, "k7q3ma")[0] as string;
    expect(parsed.segments).toEqual({ [path]: backend.files.get(path)?.length });
  });

  it("rejects a token naming a segment now shorter or absent", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    await events.append({ type: "t", data: {} });
    const { token } = await events.changes();
    const path = segmentsOf(backend, "k7q3ma")[0] as string;
    const bytes = backend.files.get(path) as Uint8Array;
    backend.files.set(path, bytes.slice(0, bytes.length - 1));
    await expect(events.changes(undefined, token)).rejects.toThrow(BadToken);
    backend.files.delete(path);
    await expect(events.changes(undefined, token)).rejects.toThrow(BadToken);
    for (const bad of ["", "{}", JSON.stringify({ instance: "x", store: "vault", segments: {} }), JSON.stringify({ instance: (JSON.parse(token) as { instance: string }).instance, store: "vault", segments: { [path]: -1 } })]) {
      await expect(events.changes(undefined, bad), bad).rejects.toThrow(BadToken);
    }
  });

  it("yields the lines past since in every segment, including one another writer appended by hand", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const a1 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z");
    await events.ingest([a1]);
    const { token: since } = await events.changes();
    const mine = await events.append({ type: "t", data: {} });
    const a2 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000002", "2026-08-30T10:00:01Z");
    await backend.append(segmentsOf(backend, "aaaaaa")[0] as string, enc.encode(JSON.stringify(a2) + "\n"));
    const { events: delta } = await events.changes(undefined, since);
    expect((await all(delta)).map((e) => e.eid).sort()).toEqual([mine.eid, a2.eid].sort());
  });

  it("skips a fragment at the frontier and yields the line once it is whole", async () => {
    const { backend, events } = open({ self: "k7q3ma" });
    const a1 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000001", "2026-08-30T10:00:00Z");
    await events.ingest([a1]);
    const path = segmentsOf(backend, "aaaaaa")[0] as string;
    const a2 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000002", "2026-08-30T10:00:01Z");
    const line = JSON.stringify(a2) + "\n";
    await backend.append(path, enc.encode(line.slice(0, 10)));
    const first = await events.changes();
    expect(await all(first.events)).toEqual([a1]);
    await backend.append(path, enc.encode(line.slice(10)));
    const second = await events.changes(undefined, first.token);
    // the tail of the line alone is not a line; the whole line straddles the two frontiers and belongs to neither
    expect(await all(second.events)).toEqual([]);
    const a3 = foreign("aaaaaa", "01990000-0000-7000-8000-000000000003", "2026-08-30T10:00:02Z");
    await backend.append(path, enc.encode(JSON.stringify(a3) + "\n"));
    const third = await events.changes(undefined, second.token);
    expect(await all(third.events)).toEqual([a3]);
  });
});

describe("folder: blobs on disk", () => {
  it("is one file per block, flat, named by CID, holding the block's bytes", async () => {
    const { backend, blobs } = open();
    expect(await blobs.put(enc.encode("hello"))).toBe(HELLO_CID);
    expect(fileText(backend, `.estoc/blobs/${HELLO_CID}`)).toBe("hello");
    const root = await blobs.put(bigBytes());
    const files = [...backend.files.keys()].filter((p) => p.startsWith(".estoc/blobs/"));
    expect(files).toHaveLength(4);
    expect(files.every((p) => kindOf(p.slice(".estoc/".length)) === "blob")).toBe(true);
    expect(await blobs.get(root)).toEqual(bigBytes());
  });

  it("rewrites a block it already holds so the file's time is renewed", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const { backend, blobs } = open({ clock: c.now, graceMs: HOUR });
    await blobs.put(enc.encode("hello"));
    c.advance(HOUR - 1);
    await blobs.put(enc.encode("hello"));
    expect(await backend.modified(`.estoc/blobs/${HELLO_CID}`)).toBe(c.now().getTime());
    c.advance(HOUR - 1);
    expect(await blobs.collect([])).toEqual({ unlinked: [], young: [HELLO_CID] });
    c.advance(1);
    expect(await blobs.collect([])).toEqual({ unlinked: [HELLO_CID], young: [] });
  });

  it("moves a block that is not its name's aside, out of blobs/, and reads it as absent", async () => {
    const { backend, blobs } = open();
    await backend.write(`.estoc/blobs/${HELLO_CID}`, enc.encode("Hello"));
    expect(await blobs.has(HELLO_CID)).toBe(true); // by name, without reading
    expect(await blobs.getBlock(HELLO_CID)).toBeNull();
    expect(await blobs.has(HELLO_CID)).toBe(false);
    expect(backend.files.has(`.estoc/blobs/${HELLO_CID}`)).toBe(false);
    expect(fileText(backend, `.estoc/local/damaged/blobs/${HELLO_CID}`)).toBe("Hello");
    // and can be repaired by a sound copy
    await blobs.putBlock(HELLO_CID, enc.encode("hello"));
    expect(await blobs.get(HELLO_CID)).toEqual(enc.encode("hello"));
  });

  it("leaves a file under blobs/ that is not shaped like a block alone", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const { backend, blobs } = open({ clock: c.now, graceMs: 0 });
    await backend.write(".estoc/blobs/README", enc.encode("not a block"));
    expect(await blobs.list()).toEqual([]);
    expect(await blobs.has("README")).toBe(false);
    expect(await blobs.collect([])).toEqual({ unlinked: [], young: [] });
    expect(backend.files.has(".estoc/blobs/README")).toBe(true);
    expect(await new FolderFileStore(backend, ".estoc").list()).toEqual(["blobs/README"]);
  });
});

describe("folder: files", () => {
  it("is every path under .estoc/ that is not a segment, a blob or local/, by shape", async () => {
    const backend = new MemoryBackend();
    const store = folderStore(backend, { self: "k7q3ma" });
    await store.events.append({ type: "t", data: {} });
    await store.blobs.put(enc.encode("hello"));
    const ext = "01990000-0000-7000-8000-0000000000ee";
    const extStore = folderStore(backend, { self: "k7q3ma", base: `.estoc/extensions/${ext}`, store: ext });
    await extStore.events.append({ type: "t", data: {} });
    await extStore.blobs.put(enc.encode("hello"));
    for (const path of ["config.json", "keystore.json", "state/cursor.json", `extensions/${ext}/notes.txt`, "extensions/not-an-ext/devices/k7q3ma/x.jsonl", "local/self.json", "local/agent/options.json"]) {
      await backend.write(`.estoc/${path}`, enc.encode("{}"));
    }
    const files = new FolderFileStore(backend, ".estoc");
    expect(await files.list()).toEqual([
      "config.json",
      `extensions/${ext}/notes.txt`,
      "extensions/not-an-ext/devices/k7q3ma/x.jsonl",
      "keystore.json",
      "state/cursor.json",
    ]);
    expect(await files.read("config.json")).toEqual(enc.encode("{}"));
    expect(await files.read("nope.json")).toBeNull();
    await files.write("state/draft.json", enc.encode("[]"));
    expect(backend.files.get(".estoc/state/draft.json")).toEqual(enc.encode("[]"));
  });

  it("refuses a path shaped like a segment, a blob, or local/", async () => {
    const files = new FolderFileStore(new MemoryBackend(), ".estoc");
    for (const bad of [
      "devices/k7q3ma/01990000-0000-7000-8000-000000000010.jsonl",
      `blobs/${HELLO_CID}`,
      `extensions/01990000-0000-7000-8000-0000000000ee/blobs/${HELLO_CID}`,
      "local/self.json",
      "local",
      "../x",
      "café",
    ]) {
      await expect(files.write(bad, new Uint8Array()), bad).rejects.toThrow();
      await expect(files.read(bad), bad).rejects.toThrow();
    }
  });
});

describe("folder: kindOf", () => {
  it("tells the four kinds apart by shape alone", () => {
    const dev = mintDeviceId();
    expect(kindOf(`devices/${dev}/01990000-0000-7000-8000-000000000010.jsonl`)).toBe("segment");
    expect(kindOf(`devices/${dev}/01990000-0000-7000-8000-000000000010.json`)).toBe("file");
    expect(kindOf(`devices/${dev}/deeper/01990000-0000-7000-8000-000000000010.jsonl`)).toBe("file");
    expect(kindOf(`blobs/${HELLO_CID}`)).toBe("blob");
    expect(kindOf(`blobs/${HELLO_CID.toUpperCase()}`)).toBe("file");
    expect(kindOf(`blobs/deeper/${HELLO_CID}`)).toBe("file");
    expect(kindOf(`extensions/01990000-0000-7000-8000-0000000000ee/blobs/${HELLO_CID}`)).toBe("blob");
    expect(kindOf(`extensions/01990000-0000-7000-8000-0000000000ee/devices/${dev}/01990000-0000-7000-8000-000000000010.jsonl`)).toBe("segment");
    expect(kindOf(`extensions/onion/blobs/${HELLO_CID}`)).toBe("file");
    expect(kindOf("extensions/01990000-0000-7000-8000-0000000000ee")).toBe("file");
    // an extension's tree has no local/ and no extensions/ of its own (§3.1): such paths are files, carried
    expect(kindOf("extensions/01990000-0000-7000-8000-0000000000ee/local/self.json")).toBe("file");
    expect(kindOf(`extensions/01990000-0000-7000-8000-0000000000ee/extensions/01990000-0000-7000-8000-0000000000ef/blobs/${HELLO_CID}`)).toBe("file");
    expect(kindOf("extensions/01990000-0000-7000-8000-0000000000ee/config.json")).toBe("file");
    expect(kindOf("local")).toBe("local");
    expect(kindOf("local/agent/trace/wire/01990000-0000-7000-8000-000000000010.jsonl")).toBe("local");
    expect(kindOf("config.json")).toBe("file");
  });
});
