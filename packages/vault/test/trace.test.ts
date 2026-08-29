import { describe, expect, it } from "vitest";

import {
  MemoryBackend,
  TRACE_DIR,
  TRACE_NORMAL,
  TRACE_OFF,
  TraceLog,
  isSegment,
  segmentTime,
  tracePolicy,
  type TracePolicy,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const dec = new TextDecoder();

/** A clock the test moves by hand. */
function clock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => (t += ms) };
}

function policy(over: Partial<TracePolicy> = {}): TracePolicy {
  return { ...TRACE_NORMAL, ...over };
}

async function segmentsOf(backend: MemoryBackend, stream: string): Promise<string[]> {
  return (await backend.list(`${TRACE_DIR}/${stream}`)).sort();
}

describe("trace log", () => {
  it("stamps stream, tid and at, and reads back what it wrote", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const trace = new TraceLog(backend, policy(), c.now);
    const outer = await trace.append("wire", { event: "wire.in", via: "ws", bytes: 812 });
    const inner = await trace.append("envelope", { event: "envelope.open", parent: outer, kind: "authcrypt", mid: "m1" });
    expect(outer).toMatch(/^[0-9a-f-]{36}$/);
    const wire = await trace.read("wire");
    expect(wire).toEqual([{ stream: "wire", tid: outer, at: "2026-08-29T10:00:00.000Z", event: "wire.in", via: "ws", bytes: 812 }]);
    const envelope = await trace.read("envelope");
    expect(envelope[0]).toMatchObject({ stream: "envelope", tid: inner, parent: outer, mid: "m1", kind: "authcrypt" });
    // one segment per stream, uuidv7-named, one line per event
    const names = await segmentsOf(backend, "wire");
    expect(names).toHaveLength(1);
    expect(isSegment(names[0] as string)).toBe(true);
    expect(dec.decode((await backend.read(`${TRACE_DIR}/wire/${names[0]}`)) as Uint8Array)).toMatch(/^\{.*\}\n$/);
  });

  it("writes nothing for a stream that is off, but still mints a tid to hang children on", async () => {
    const backend = new MemoryBackend();
    const trace = new TraceLog(backend, TRACE_OFF);
    const tid = await trace.append("wire", { event: "wire.in" });
    expect(tid).toMatch(/^[0-9a-f-]{36}$/);
    expect(trace.enabled("wire")).toBe(false);
    expect(await backend.list(`${TRACE_DIR}/wire`)).toEqual([]);
    expect(await trace.read("wire")).toEqual([]);
  });

  it("rotates a segment at rotate.bytes or rotate.ms, whichever comes first", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const trace = new TraceLog(backend, policy({ rotate: { bytes: 200, ms: HOUR } }), c.now);
    await trace.append("diag", { event: "log", text: "x".repeat(150) }); // ~200 bytes: fills the segment
    await trace.append("diag", { event: "log", text: "second" }); // over: a new one
    expect(await segmentsOf(backend, "diag")).toHaveLength(2);
    c.advance(HOUR);
    await trace.append("diag", { event: "log", text: "an hour on" }); // aged out: a third
    expect(await segmentsOf(backend, "diag")).toHaveLength(3);
    expect((await trace.read("diag")).map((e) => e.text)).toEqual(["x".repeat(150), "second", "an hour on"]);
  });

  it("each session starts a segment of its own; a cut-short line from before is skipped, not healed", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const first = new TraceLog(backend, policy(), c.now);
    await first.append("diag", { event: "log", n: 1 });
    const [name] = await segmentsOf(backend, "diag");
    await backend.append(`${TRACE_DIR}/diag/${name}`, new TextEncoder().encode('{"stream":"diag","tid":"cut'));
    c.advance(1000);
    const second = new TraceLog(backend, policy(), c.now);
    await second.append("diag", { event: "log", n: 2 });
    expect(await segmentsOf(backend, "diag")).toHaveLength(2);
    const damaged: string[] = [];
    const events = await second.read("diag", (d) => damaged.push(d.where));
    expect(events.map((e) => e.n)).toEqual([1, 2]);
    expect(damaged).toEqual([`${name}:2`]);
  });

  it("prune drops by name the segments whose every line is past keep", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-01T00:00:00.000Z");
    const trace = new TraceLog(backend, policy({ rotate: { bytes: 1 << 20, ms: DAY } }), c.now);
    await trace.append("mediation", { event: "status", day: 1 });
    c.advance(DAY);
    await trace.append("mediation", { event: "status", day: 2 });
    c.advance(DAY);
    await trace.append("mediation", { event: "status", day: 3 });
    const before = await segmentsOf(backend, "mediation");
    expect(before).toHaveLength(3);
    expect(segmentTime(before[0] as string)).toBe(new Date("2026-08-01T00:00:00.000Z").getTime());

    // mediation keeps 7d; the first segment (named day 1, lines up to day 2) is safe until day 1 + 1d + 7d
    c.advance(5 * DAY); // day 8: nothing surely older than 7 days
    let reports = await trace.prune();
    expect(reports.find((r) => r.stream === "mediation")).toEqual({ stream: "mediation", byKeep: 0, byCap: 0, bytesFreed: 0 });
    expect(await segmentsOf(backend, "mediation")).toHaveLength(3);

    c.advance(DAY); // day 9: segment 1's last possible line (day 2) is now 7 days old
    reports = await trace.prune();
    expect(reports.find((r) => r.stream === "mediation")).toMatchObject({ byKeep: 1, byCap: 0 });
    expect((await trace.read("mediation")).map((e) => e.day)).toEqual([2, 3]);
    // no diag line for an ordinary keep prune
    expect(await trace.read("diag")).toEqual([]);
  });

  it("prune empties a stream turned off", async () => {
    const backend = new MemoryBackend();
    const on = new TraceLog(backend, policy());
    await on.append("wire.bytes", { event: "wire.in", body: "…" });
    const off = new TraceLog(backend, tracePolicy("off"));
    const reports = await off.prune();
    expect(reports.find((r) => r.stream === "wire.bytes")).toMatchObject({ byKeep: 1 });
    expect(await backend.list(`${TRACE_DIR}/wire.bytes`)).toEqual([]);
  });

  it("prune drops the oldest segments to get under cap, and says so in diag", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const p = policy({ rotate: { bytes: 100, ms: DAY } });
    p.streams = { ...p.streams, wire: { keepMs: 30 * DAY, capBytes: 250 } };
    const trace = new TraceLog(backend, p, c.now);
    for (let i = 0; i < 5; i += 1) {
      await trace.append("wire", { event: "wire.out", i, pad: "p".repeat(40) });
      c.advance(1);
    }
    const names = await segmentsOf(backend, "wire");
    expect(names).toHaveLength(5);
    const sizes = await Promise.all(names.map((n) => backend.size(`${TRACE_DIR}/wire/${n}`)));
    const total = sizes.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) as number;
    expect(total).toBeGreaterThan(250);

    const reports = await trace.prune();
    const wire = reports.find((r) => r.stream === "wire");
    expect(wire?.byCap).toBeGreaterThan(0);
    const left = await segmentsOf(backend, "wire");
    expect(left).toEqual(names.slice(names.length - left.length)); // the newest survive
    const leftBytes = (await Promise.all(left.map((n) => backend.size(`${TRACE_DIR}/wire/${n}`)))).reduce((a, b) => (a ?? 0) + (b ?? 0), 0);
    expect(leftBytes).toBeLessThanOrEqual(250);
    expect(left.length).toBeGreaterThan(0);
    expect((await trace.read("wire")).map((e) => e.i)).toEqual([0, 1, 2, 3, 4].slice(5 - left.length));

    const diag = await trace.read("diag");
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ event: "prune", reason: "cap", of: "wire", segments: wire?.byCap, bytes: wire?.bytesFreed });
  });

  it("keeps appending after its open segment was pruned away", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const p = policy();
    p.streams = { ...p.streams, diag: { keepMs: 7 * DAY, capBytes: 1 } };
    const trace = new TraceLog(backend, p, c.now);
    await trace.append("diag", { event: "log", n: 1 });
    await trace.prune(); // cap 1: the open segment goes (and the prune line lands in a fresh one)
    await trace.append("diag", { event: "log", n: 2 });
    const events = await trace.read("diag");
    expect(events.map((e) => e.event)).toEqual(["prune", "log"]);
    expect(events[1]).toMatchObject({ n: 2 });
  });

  it("traceOf(mid) is the whole onion: the frame, every envelope inside it, and what came out", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const trace = new TraceLog(backend, policy(), c.now);
    // an inbound frame with a forward around an anoncrypt around an authcrypt, ending in record m1
    const frame = await trace.append("wire", { event: "wire.in", via: "ws" });
    c.advance(1);
    const bytes = await trace.append("wire.bytes", { event: "wire.in", parent: frame, body: "eyJ…" });
    c.advance(1);
    const forward = await trace.append("envelope", { event: "envelope.open", parent: frame, kind: "forward" });
    c.advance(1);
    const anon = await trace.append("envelope", { event: "envelope.open", parent: forward, kind: "anoncrypt" });
    c.advance(1);
    const auth = await trace.append("envelope", { event: "envelope.open", parent: anon, kind: "authcrypt", mid: "m1" });
    c.advance(1);
    // unrelated: another frame with its own message, and a mediation ritual with no mid
    const other = await trace.append("wire", { event: "wire.in", via: "http" });
    await trace.append("envelope", { event: "envelope.open", parent: other, kind: "authcrypt", mid: "m2" });
    await trace.append("mediation", { event: "status", parent: frame });

    const onion = await trace.traceOf("m1");
    expect(onion.map((e) => e.tid)).toEqual([frame, bytes, forward, anon, auth, expect.any(String)]);
    expect(onion.map((e) => e.stream)).toEqual(["wire", "wire.bytes", "envelope", "envelope", "envelope", "mediation"]);
    expect(onion.some((e) => e.mid === "m2")).toBe(false);
    expect(await trace.traceOf("never")).toEqual([]);
  });

  it("traceOf(mid) keeps to its own onion: two messages in one delivery do not see each other", async () => {
    const backend = new MemoryBackend();
    const c = clock("2026-08-29T10:00:00.000Z");
    const trace = new TraceLog(backend, policy(), c.now);
    const frame = await trace.append("wire", { event: "wire.in", via: "ws" });
    c.advance(1);
    const bytes = await trace.append("wire.bytes", { event: "wire.in", parent: frame, body: "…" });
    c.advance(1);
    const delivery = await trace.append("envelope", { event: "envelope.open", parent: frame, kind: "authcrypt" });
    c.advance(1);
    const ritual = await trace.append("mediation", { event: "mediation.in", parent: delivery });
    c.advance(1);
    const one = await trace.append("envelope", { event: "envelope.open", parent: delivery, kind: "authcrypt", mid: "m1" });
    c.advance(1);
    const two = await trace.append("envelope", { event: "envelope.open", parent: delivery, kind: "authcrypt", mid: "m2" });
    c.advance(1);
    await trace.append("envelope", { event: "envelope.open", parent: two, kind: "plain", note: "inside m2 only" });

    const onion = await trace.traceOf("m1");
    expect(onion.map((e) => e.tid)).toEqual([frame, bytes, delivery, ritual, one]);
    expect(onion.some((e) => e.mid === "m2" || e.note !== undefined)).toBe(false);
    const other = await trace.traceOf("m2");
    expect(other.map((e) => e.tid)).toEqual([frame, bytes, delivery, ritual, two, expect.any(String)]);
    expect(other.some((e) => e.mid === "m1")).toBe(false);
  });

  it("policy levels: off is all zero, verbose keeps longer than normal", () => {
    expect(Object.values(tracePolicy("off").streams).every((s) => s.keepMs === 0)).toBe(true);
    expect(tracePolicy("normal")).toBe(TRACE_NORMAL);
    for (const stream of Object.keys(TRACE_NORMAL.streams) as (keyof typeof TRACE_NORMAL.streams)[]) {
      expect(tracePolicy("verbose").streams[stream].keepMs).toBeGreaterThan(TRACE_NORMAL.streams[stream].keepMs);
    }
  });
});
