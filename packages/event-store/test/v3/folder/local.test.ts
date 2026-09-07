import { describe, expect, it } from "vitest";

import { FolderLocalEventStore, InvalidEvent, LocalOwner, MemoryBackend, isSegmentName, segmentTime, text, utf8, type LocalEvent } from "../../../src/v3/index.js";
import { all, clock, expectBytes, uuidv7At } from "../suite/helpers.js";

const DAY = 24 * 60 * 60 * 1000;
const DIR = ".estoc/local/agent/trace/wire";

function line(n: number, at: string, type = "wire.out", data: Record<string, string | number | null> = {}): LocalEvent {
  return { eventId: uuidv7At(1_700_000_000_000 + n, n), at, type, data };
}

describe("trace stream (vault-folder.md §10.2)", () => {
  it("appends lines minted by the producer as canonical text and an LF, checks the shape and nothing else", async () => {
    const backend = new MemoryBackend();
    const store = new FolderLocalEventStore(backend, DIR);
    const a = line(1, "2026-08-30T10:00:00.000Z", "wire.out", { parent: null });
    await store.append(a);
    const paths = [...backend.files.keys()];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^\.estoc\/local\/agent\/trace\/wire\/[0-9a-f-]+\.jsonl$/);
    expect(isSegmentName((paths[0] as string).split("/").at(-1) as string)).toBe(true);
    expect(text(backend.files.get(paths[0] as string) as Uint8Array)).toBe(`{"at":"${a.at}","data":{"parent":null},"eventId":"${a.eventId}","type":"wire.out"}\n`);
    for (const bad of [
      { ...a, author: "019b2a43-4a56-7c0f-862f-194c0c4124a0" },
      { ...a, roots: [] },
      { eid: a.eventId, at: a.at, type: "t", data: {} },
      { eventId: a.eventId, at: a.at, type: "", data: {} },
      { eventId: "x", at: a.at, type: "t", data: {} },
      { eventId: a.eventId, at: "2026-08-30T10:00:00Z", type: "t", data: {} },
      { eventId: a.eventId, at: a.at, type: "t" },
    ]) {
      await expect(store.append(bad as LocalEvent), JSON.stringify(bad)).rejects.toThrow(InvalidEvent);
    }
  });

  it("scans in canonical order, by equality, and reports damaged lines without yielding them", async () => {
    const backend = new MemoryBackend();
    const store = new FolderLocalEventStore(backend, DIR);
    const late = line(1, "2026-08-30T10:00:02.000Z", "wire.in", { parent: "p" });
    const early = line(2, "2026-08-30T10:00:00.000Z", "wire.out", { parent: null });
    const mid = line(3, "2026-08-30T10:00:01.000Z", "wire.out", { parent: "p", n: 3 });
    await store.append(late);
    await store.append(early);
    await store.append(mid);
    const path = [...backend.files.keys()][0] as string;
    await backend.append(path, utf8("{broken\n"));
    await backend.append(path, utf8(`${JSON.stringify({ ...line(5, "2026-08-30T10:00:03.000Z"), author: "x" })}\n`));
    await backend.append(path, utf8(JSON.stringify(line(4, "2026-08-30T10:00:03.000Z"))));
    expect(await all(store.scan())).toEqual([early, mid, late]);
    expect(store.damaged().map((d) => d.error)).toEqual([expect.stringMatching(/JSON|syntax|token/i), "not a local event", "incomplete final fragment"]);
    expect(store.damaged().map((d) => d.where)).toEqual([`${path}:4`, `${path}:5`, `${path}:6`]);
    expect(await all(store.scan({ eventId: mid.eventId }))).toEqual([mid]);
    expect(await all(store.scan({ type: "wire.out" }))).toEqual([early, mid]);
    expect(await all(store.scan({ data: { parent: "p" } }))).toEqual([mid, late]);
    expect(await all(store.scan({ data: { parent: null } }))).toEqual([early]);
    expect(await all(store.scan({ type: "wire.out", data: { n: 3 } }))).toEqual([mid]);
    expect(Object.isFrozen((await all(store.scan()))[0])).toBe(true);
  });

  it("rotates by bytes or age, and prunes whole segments by name, then by cap", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const at = (): string => new Date(c.now()).toISOString();
    const backend = new MemoryBackend({ clock: () => new Date(c.now()) });
    const store = new FolderLocalEventStore(backend, DIR, { now: c.now, rotate: { bytes: 200, ms: DAY } });
    const segments = (): string[] => [...backend.files.keys()].sort();
    await store.append(line(1, at()));
    await store.append(line(2, at()));
    expect(segments()).toHaveLength(1);
    await store.append(line(3, at())); // past 200 bytes
    expect(segments()).toHaveLength(2);
    c.advance(DAY);
    await store.append(line(4, at())); // a day old
    expect(segments()).toHaveLength(3);
    expect(segmentTime((segments()[2] as string).split("/").at(-1) as string)).toBeLessThanOrEqual(c.now());
    // keep a day: nothing older than keep + rotate by name — the first two segments are exactly that old
    c.advance(DAY);
    expect(await store.prune({ keepMs: DAY, capBytes: 1 << 20 })).toEqual({ byKeep: 2, byCap: 0, bytesFreed: expect.any(Number) });
    expect(segments()).toHaveLength(1);
    expect(await all(store.scan())).toEqual([line(4, "2026-08-31T10:00:00.000Z")]);
    // cap: oldest first until it fits
    await store.append(line(5, at()));
    await store.append(line(6, at()));
    await store.append(line(7, at()));
    expect(segments().length).toBeGreaterThan(1);
    const report = await store.prune({ keepMs: 30 * DAY, capBytes: 150 });
    expect(report.byKeep).toBe(0);
    expect(report.byCap).toBeGreaterThan(0);
    const total = segments().reduce((sum, path) => sum + (backend.files.get(path)?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(150);
    // off: everything goes, and the next append starts afresh
    const left = segments().length;
    expect((await store.prune({ keepMs: 0, capBytes: 0 })).byKeep).toBe(left);
    expect(segments()).toEqual([]);
    await store.append(line(8, at()));
    expect(await all(store.scan())).toHaveLength(1);
  });
});

describe("LocalOwner (vault-folder.md §10.2)", () => {
  it("keeps options.json, cache/ and trace streams under local/<owner>/, and nothing else", async () => {
    const backend = new MemoryBackend();
    const owner = new LocalOwner(backend, ".estoc/local/agent");
    expect(await owner.readOptions()).toBeNull();
    await owner.writeOptions({ mediator: "did:web:m", retries: 3 });
    expect(await owner.readOptions()).toEqual({ mediator: "did:web:m", retries: 3 });
    expect(text(backend.files.get(".estoc/local/agent/options.json") as Uint8Array)).toBe('{\n  "mediator": "did:web:m",\n  "retries": 3\n}\n');
    await backend.write(".estoc/local/agent/options.json", utf8("[]"));
    await expect(owner.readOptions()).rejects.toThrow(/not a JSON object/);
    await expect(owner.writeOptions([] as unknown as Record<string, never>)).rejects.toThrow(TypeError);

    expect(await owner.cache.list()).toEqual([]);
    await owner.cache.write("fold/contacts.json", utf8("{}"));
    await owner.cache.write("index", utf8("i"));
    expect(await owner.cache.list()).toEqual(["fold/contacts.json", "index"]);
    expectBytes(await owner.cache.read("index"), utf8("i"));
    expect(await owner.cache.read("none")).toBeNull();
    await expect(owner.cache.read("../options.json")).rejects.toThrow(/relative/);
    await owner.cache.remove("index");
    expect(await owner.cache.list()).toEqual(["fold/contacts.json"]);
    await owner.cache.clear();
    expect(await owner.cache.list()).toEqual([]);

    const wire = owner.trace("wire");
    expect(owner.trace("wire")).toBe(wire);
    await wire.append(line(1, "2026-08-30T10:00:00.000Z"));
    await owner.trace("delivery").append(line(2, "2026-08-30T10:00:00.000Z", "delivery.attempted"));
    expect(wire.dir).toBe(".estoc/local/agent/trace/wire");
    expect([...backend.files.keys()].filter((p) => p.includes("/trace/")).map((p) => p.split("/")[4])).toEqual(["wire", "delivery"]);
    expect(() => owner.trace("../x")).toThrow(/relative/);
    expect([...backend.files.keys()].every((p) => p.startsWith(".estoc/local/agent/"))).toBe(true);
  });
});
