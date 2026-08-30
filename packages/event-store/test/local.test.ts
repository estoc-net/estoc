import { describe, expect, it } from "vitest";

import { FolderLocalEventStore, InvalidEvent, MemoryBackend, isSegmentName, segmentTime, type LocalEvent } from "../src/index.js";
import { all, clock } from "./suite/helpers.js";

const enc = new TextEncoder();
const DAY = 24 * 60 * 60 * 1000;

function line(n: number, at: string, type = "wire.out", data: Record<string, string | number | null> = {}): LocalEvent {
  return { eid: `01990000-0000-7000-8000-${String(n).padStart(12, "0")}`, at, type, data };
}

describe("local event store", () => {
  it("appends lines minted by the producer, checks the shape and nothing else", async () => {
    const backend = new MemoryBackend();
    const store = new FolderLocalEventStore(backend, ".estoc/local/agent/trace/wire");
    const a = line(1, "2026-08-30T10:00:00Z", "wire.out", { parent: null });
    await store.append(a);
    const paths = [...backend.files.keys()];
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/^\.estoc\/local\/agent\/trace\/wire\/[0-9a-f-]+\.jsonl$/);
    expect(isSegmentName((paths[0] as string).split("/").at(-1) as string)).toBe(true);
    expect(new TextDecoder().decode(backend.files.get(paths[0] as string))).toBe(JSON.stringify(a) + "\n");
    for (const bad of [
      { ...a, author: "k7q3ma" },
      { ...a, blobs: [] },
      { eid: a.eid, at: a.at, type: "" , data: {} },
      { eid: "x", at: a.at, type: "t", data: {} },
      { eid: a.eid, at: "yesterday", type: "t", data: {} },
      { eid: a.eid, at: a.at, type: "t" },
    ]) {
      await expect(store.append(bad as LocalEvent), JSON.stringify(bad)).rejects.toThrow(InvalidEvent);
    }
  });

  it("scans in canonical order, by equality, and skips damaged lines", async () => {
    const backend = new MemoryBackend();
    const store = new FolderLocalEventStore(backend, ".estoc/local/agent/trace/wire");
    const late = line(1, "2026-08-30T10:00:02Z", "wire.in", { parent: "p" });
    const early = line(2, "2026-08-30T10:00:00Z", "wire.out", { parent: null });
    const mid = line(3, "2026-08-30T10:00:01Z", "wire.out", { parent: "p", n: 3 });
    await store.append(late);
    await store.append(early);
    await store.append(mid);
    const path = [...backend.files.keys()][0] as string;
    await backend.append(path, enc.encode("{broken\n"));
    await backend.append(path, enc.encode(JSON.stringify(line(4, "2026-08-30T10:00:03Z"))));
    expect(await all(store.scan())).toEqual([early, mid, late]);
    expect(store.damaged().map((d) => d.error)).toEqual([expect.stringMatching(/not JSON/), "unterminated line"]);
    expect(await all(store.scan({ eid: mid.eid }))).toEqual([mid]);
    expect(await all(store.scan({ type: "wire.out" }))).toEqual([early, mid]);
    expect(await all(store.scan({ data: { parent: "p" } }))).toEqual([mid, late]);
    expect(await all(store.scan({ data: { parent: null } }))).toEqual([early]);
    expect(await all(store.scan({ type: "wire.out", data: { n: 3 } }))).toEqual([mid]);
  });

  it("orders by the instant `at` names, not its spelling, then by eid", async () => {
    const backend = new MemoryBackend();
    const store = new FolderLocalEventStore(backend, ".estoc/local/agent/trace/wire");
    const whole = line(9, "2026-08-30T10:00:00Z");
    const milli = line(1, "2026-08-30T10:00:00.001Z");
    const tenth = line(3, "2026-08-30T10:00:00.1Z");
    const tenthToo = line(2, "2026-08-30T10:00:00.10Z");
    for (const event of [milli, tenth, whole, tenthToo]) {
      await store.append(event);
    }
    // "…00Z" before "…00.001Z" as instants, though not as strings; .1Z and .10Z are one instant, so eid decides
    expect(await all(store.scan())).toEqual([whole, milli, tenthToo, tenth]);
  });

  it("rotates by bytes or age, and prunes whole segments by name, then by cap", async () => {
    const c = clock("2026-08-30T10:00:00Z");
    const backend = new MemoryBackend({ clock: c.now });
    const store = new FolderLocalEventStore(backend, ".estoc/local/agent/trace/wire", { clock: c.now, rotate: { bytes: 200, ms: DAY } });
    const segments = (): string[] => [...backend.files.keys()].sort();
    await store.append(line(1, c.now().toISOString()));
    await store.append(line(2, c.now().toISOString()));
    expect(segments()).toHaveLength(1);
    await store.append(line(3, c.now().toISOString())); // past 200 bytes
    expect(segments()).toHaveLength(2);
    expect(segmentTime((segments()[0] as string).split("/").at(-1) as string)).toBe(c.now().getTime());
    c.advance(DAY);
    await store.append(line(4, c.now().toISOString())); // a day old
    expect(segments()).toHaveLength(3);
    // keep two days: nothing older than keep + rotate by name — the first two segments are exactly that old
    c.advance(DAY);
    expect(await store.prune({ keepMs: DAY, capBytes: 1 << 20 })).toEqual({ byKeep: 2, byCap: 0, bytesFreed: expect.any(Number) });
    expect(segments()).toHaveLength(1);
    expect(await all(store.scan())).toEqual([line(4, "2026-08-31T10:00:00.000Z")]);
    // cap: oldest first until it fits
    await store.append(line(5, c.now().toISOString()));
    await store.append(line(6, c.now().toISOString()));
    await store.append(line(7, c.now().toISOString()));
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
    await store.append(line(8, c.now().toISOString()));
    expect(await all(store.scan())).toHaveLength(1);
  });
});
