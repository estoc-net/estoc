import { describe, expect, it } from "vitest";

import { ESTOC_DIR, MemoryBackend, isSegmentName, segmentTime, type LocalOwner } from "@estoc/event-store";
import { createSeedKeystore, type SeedKey } from "@estoc/keystore";

import { AgentTrace, TRACE_NORMAL, TRACE_OFF, createVault, openVault, traceLevelOf, tracePolicy, type PeerVault, type TracePolicy, type TraceStream } from "../../src/v2/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEED = new Uint8Array(32).map((_, i) => i);
const dec = new TextDecoder();
const enc = new TextEncoder();
const TRACE = `${ESTOC_DIR}/local/agent/trace`;

/** A clock the test moves by hand. */
function clock(start: string): { now: () => Date; advance: (ms: number) => void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

interface Scene {
  backend: MemoryBackend;
  seedKey: SeedKey;
  vault: PeerVault;
  /** the vault's `local("agent")` */
  agent: LocalOwner;
}

/** A vault on a fresh backend, the folder on the test's clock and, when given, rotation. */
async function scene(c: { now: () => Date }, rotate?: { bytes: number; ms: number }): Promise<Scene> {
  const backend = new MemoryBackend();
  const { doc, seedKey } = await createSeedKeystore("test", { seed: SEED });
  const vault = await createVault(backend, { keystore: doc, seedKey, label: "Alice", clock: c.now, ...(rotate === undefined ? {} : { vault: { trace: rotate } }) });
  return { backend, seedKey, vault, agent: vault.vault.local("agent") };
}

/** Normal, with some streams kept otherwise. */
function policy(over: Partial<TracePolicy["streams"]> = {}): TracePolicy {
  return { streams: { ...TRACE_NORMAL.streams, ...over } };
}

async function segmentsOf(backend: MemoryBackend, stream: TraceStream): Promise<string[]> {
  return (await backend.list(`${TRACE}/${stream}`)).sort();
}

describe("v2 trace", () => {
  it("mints eid and at, keeps data as given less what is undefined, and reads back what it wrote", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, agent } = await scene(c);
    const trace = new AgentTrace(agent, { clock: c.now });
    const outer = await trace.append("wire", "wire.in", { via: "ws", bytes: 812, parent: undefined });
    c.advance(1);
    const inner = await trace.append("envelope", "envelope.open", { parent: outer, kind: "authcrypt", mid: "m1" });
    expect(outer).toMatch(/^[0-9a-f-]{36}$/);
    expect(await trace.read("wire")).toEqual([{ stream: "wire", eid: outer, at: "2026-08-29T10:00:00.000Z", type: "wire.in", data: { via: "ws", bytes: 812 } }]);
    expect(await trace.read("envelope")).toEqual([
      { stream: "envelope", eid: inner, at: "2026-08-29T10:00:00.001Z", type: "envelope.open", data: { parent: outer, kind: "authcrypt", mid: "m1" } },
    ]);
    // one segment per stream under local/agent/trace/<stream>/, uuidv7-named, one line per event;
    // a line is the local event and nothing more — the stream is the directory it is in
    const names = await segmentsOf(backend, "wire");
    expect(names).toHaveLength(1);
    expect(isSegmentName(names[0] as string)).toBe(true);
    const line = dec.decode((await backend.read(`${TRACE}/wire/${names[0]}`)) as Uint8Array);
    expect(line).toMatch(/^\{.*\}\n$/);
    expect(Object.keys(JSON.parse(line))).toEqual(["eid", "at", "type", "data"]);
    // a filter reads by id, and by a field of data
    expect((await trace.read("envelope", { eid: inner })).map((e) => e.eid)).toEqual([inner]);
    expect((await trace.read("envelope", { data: { parent: outer } })).map((e) => e.eid)).toEqual([inner]);
    expect(await trace.read("envelope", { data: { mid: "m2" } })).toEqual([]);
    // what is not JSON is refused, not bent
    await expect(trace.append("diag", "log", { body: new Uint8Array(2) as unknown as string })).rejects.toThrow(/JSON/);
  });

  it("writes nothing for a stream that is off, but still mints an eid to hang children on", async () => {
    const { backend, agent } = await scene(clock("2026-08-29T10:00:00.000Z"));
    const trace = new AgentTrace(agent, { level: "off" });
    const eid = await trace.append("wire", "wire.in");
    expect(eid).toMatch(/^[0-9a-f-]{36}$/);
    expect(trace.enabled("wire")).toBe(false);
    expect(trace.policy).toBe(TRACE_OFF);
    expect(await backend.list(`${TRACE}/wire`)).toEqual([]);
    expect(await trace.read("wire")).toEqual([]);
  });

  it("rotates its segments as the folder was told to at open: by bytes or by age, whichever comes first", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, agent } = await scene(c, { bytes: 200, ms: HOUR });
    const trace = new AgentTrace(agent, { clock: c.now });
    await trace.append("diag", "log", { text: "x".repeat(150) }); // over 200 bytes: fills the segment
    await trace.append("diag", "log", { text: "second" }); // a new one
    expect(await segmentsOf(backend, "diag")).toHaveLength(2);
    c.advance(HOUR);
    await trace.append("diag", "log", { text: "an hour on" }); // aged out: a third
    expect(await segmentsOf(backend, "diag")).toHaveLength(3);
    expect((await trace.read("diag")).map((e) => e.data["text"])).toEqual(["x".repeat(150), "second", "an hour on"]);
  });

  it("each open of the folder starts segments of its own; a cut-short line from before is skipped, not healed", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, seedKey, agent } = await scene(c);
    const first = new AgentTrace(agent, { clock: c.now });
    await first.append("diag", "log", { n: 1 });
    const [name] = await segmentsOf(backend, "diag");
    await backend.append(`${TRACE}/diag/${name}`, enc.encode('{"eid":"cut'));
    c.advance(1000);
    const again = await openVault(backend, seedKey, { clock: c.now });
    const second = new AgentTrace(again.vault.local("agent"), { clock: c.now });
    await second.append("diag", "log", { n: 2 });
    expect(await segmentsOf(backend, "diag")).toHaveLength(2);
    expect((await second.read("diag")).map((e) => e.data["n"])).toEqual([1, 2]);
    expect(second.damaged("diag")).toMatchObject([{ where: `${TRACE}/diag/${name}:2`, error: "unterminated line" }]);
  });

  it("prune drops by name the segments whose every line is past keep", async () => {
    const c = clock("2026-08-01T00:00:00.000Z");
    const { backend, agent } = await scene(c, { bytes: 1 << 20, ms: DAY });
    const trace = new AgentTrace(agent, { clock: c.now });
    await trace.append("mediation", "status", { day: 1 });
    c.advance(DAY);
    await trace.append("mediation", "status", { day: 2 });
    c.advance(DAY);
    await trace.append("mediation", "status", { day: 3 });
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
    expect((await trace.read("mediation")).map((e) => e.data["day"])).toEqual([2, 3]);
    // no diag line for an ordinary keep prune
    expect(await trace.read("diag")).toEqual([]);
  });

  it("prune empties a stream turned off", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, agent } = await scene(c);
    const on = new AgentTrace(agent, { clock: c.now });
    await on.append("wire.bytes", "wire.in", { body: "…" });
    const off = new AgentTrace(agent, { clock: c.now, level: "off" });
    const reports = await off.prune();
    expect(reports.find((r) => r.stream === "wire.bytes")).toMatchObject({ byKeep: 1 });
    expect(await backend.list(`${TRACE}/wire.bytes`)).toEqual([]);
  });

  it("prune drops the oldest segments to get under cap, and says so in diag", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, agent } = await scene(c, { bytes: 100, ms: DAY });
    const trace = new AgentTrace(agent, { clock: c.now, policy: policy({ wire: { keepMs: 30 * DAY, capBytes: 250 } }) });
    for (let i = 0; i < 5; i += 1) {
      await trace.append("wire", "wire.out", { i, pad: "p".repeat(40) });
      c.advance(1);
    }
    const names = await segmentsOf(backend, "wire");
    expect(names).toHaveLength(5);
    const sizes = await Promise.all(names.map((n) => backend.size(`${TRACE}/wire/${n}`)));
    const total = sizes.reduce((a, b) => (a ?? 0) + (b ?? 0), 0) as number;
    expect(total).toBeGreaterThan(250);

    const reports = await trace.prune();
    const wire = reports.find((r) => r.stream === "wire");
    expect(wire?.byCap).toBeGreaterThan(0);
    const left = await segmentsOf(backend, "wire");
    expect(left).toEqual(names.slice(names.length - left.length)); // the newest survive
    const leftBytes = (await Promise.all(left.map((n) => backend.size(`${TRACE}/wire/${n}`)))).reduce((a, b) => (a ?? 0) + (b ?? 0), 0);
    expect(leftBytes).toBeLessThanOrEqual(250);
    expect(left.length).toBeGreaterThan(0);
    expect((await trace.read("wire")).map((e) => e.data["i"])).toEqual([0, 1, 2, 3, 4].slice(5 - left.length));

    const diag = await trace.read("diag");
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ type: "prune", data: { reason: "cap", of: "wire", segments: wire?.byCap, bytes: wire?.bytesFreed } });
  });

  it("keeps appending after its open segment was pruned away", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { agent } = await scene(c);
    const trace = new AgentTrace(agent, { clock: c.now, policy: policy({ diag: { keepMs: 7 * DAY, capBytes: 1 } }) });
    await trace.append("diag", "log", { n: 1 });
    await trace.prune(); // cap 1: the open segment goes (and the prune line lands in a fresh one)
    await trace.append("diag", "log", { n: 2 });
    const events = await trace.read("diag");
    expect(events.map((e) => e.type)).toEqual(["prune", "log"]);
    expect(events[1]).toMatchObject({ data: { n: 2 } });
  });

  it("traceOf(mid) is the whole onion: the frame, every envelope inside it, and what came out", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { agent } = await scene(c);
    const trace = new AgentTrace(agent, { clock: c.now });
    // an inbound frame with a forward around an anoncrypt around an authcrypt, ending in record m1
    const frame = await trace.append("wire", "wire.in", { via: "ws" });
    c.advance(1);
    const bytes = await trace.append("wire.bytes", "wire.in", { parent: frame, body: "eyJ…" });
    c.advance(1);
    const forward = await trace.append("envelope", "envelope.open", { parent: frame, kind: "forward" });
    c.advance(1);
    const anon = await trace.append("envelope", "envelope.open", { parent: forward, kind: "anoncrypt" });
    c.advance(1);
    const auth = await trace.append("envelope", "envelope.open", { parent: anon, kind: "authcrypt", mid: "m1" });
    c.advance(1);
    // unrelated: another frame with its own message, and a mediation ritual with no mid
    const other = await trace.append("wire", "wire.in", { via: "http" });
    await trace.append("envelope", "envelope.open", { parent: other, kind: "authcrypt", mid: "m2" });
    await trace.append("mediation", "status", { parent: frame });

    const onion = await trace.traceOf("m1");
    expect(onion.map((e) => e.eid)).toEqual([frame, bytes, forward, anon, auth, expect.any(String)]);
    expect(onion.map((e) => e.stream)).toEqual(["wire", "wire.bytes", "envelope", "envelope", "envelope", "mediation"]);
    expect(onion.some((e) => e.data["mid"] === "m2")).toBe(false);
    expect(await trace.traceOf("never")).toEqual([]);
  });

  it("traceOf(mid) keeps to its own onion: two messages in one delivery do not see each other", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { agent } = await scene(c);
    const trace = new AgentTrace(agent, { clock: c.now });
    const frame = await trace.append("wire", "wire.in", { via: "ws" });
    c.advance(1);
    const bytes = await trace.append("wire.bytes", "wire.in", { parent: frame, body: "…" });
    c.advance(1);
    const delivery = await trace.append("envelope", "envelope.open", { parent: frame, kind: "authcrypt" });
    c.advance(1);
    const ritual = await trace.append("mediation", "mediation.in", { parent: delivery });
    c.advance(1);
    const one = await trace.append("envelope", "envelope.open", { parent: delivery, kind: "authcrypt", mid: "m1" });
    c.advance(1);
    const two = await trace.append("envelope", "envelope.open", { parent: delivery, kind: "authcrypt", mid: "m2" });
    c.advance(1);
    await trace.append("envelope", "envelope.open", { parent: two, kind: "plain", note: "inside m2 only" });

    const onion = await trace.traceOf("m1");
    expect(onion.map((e) => e.eid)).toEqual([frame, bytes, delivery, ritual, one]);
    expect(onion.some((e) => e.data["mid"] === "m2" || e.data["note"] !== undefined)).toBe(false);
    const other = await trace.traceOf("m2");
    expect(other.map((e) => e.eid)).toEqual([frame, bytes, delivery, ritual, two, expect.any(String)]);
    expect(other.some((e) => e.data["mid"] === "m1")).toBe(false);
  });

  it("traceOf(mid) goes as deep as the onion does: envelopes inside the ends, and what hung on the frame's answer", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { agent } = await scene(c);
    const trace = new AgentTrace(agent, { clock: c.now });
    const next = async (stream: TraceStream, type: string, data: Parameters<AgentTrace["append"]>[2]): Promise<string> => {
      const eid = await trace.append(stream, type, data);
      c.advance(1);
      return eid;
    };
    // outbound: one frame carrying two sealed messages, one of them signed inside; the mediator's answer, its bytes, and a status opened out of it
    const out = await next("wire", "wire.out", { via: "http" });
    const sealOne = await next("envelope", "envelope.seal", { parent: out, kind: "authcrypt", mid: "m1" });
    const sealTwo = await next("envelope", "envelope.seal", { parent: out, kind: "authcrypt", mid: "m2" });
    const signedTwo = await next("envelope", "envelope.seal", { parent: sealTwo, kind: "signed" });
    const answer = await next("wire", "wire.in", { via: "http", parent: out, status: 200 });
    const answerBytes = await next("wire.bytes", "wire.in", { parent: answer, body: "…" });
    const opened = await next("envelope", "envelope.open", { parent: answer, kind: "authcrypt" });
    const ritual = await next("mediation", "mediation.in", { parent: opened });
    // inbound: an authcrypt around a signed around a plain, the record on the outermost
    const frame = await next("wire", "wire.in", { via: "ws" });
    const auth = await next("envelope", "envelope.open", { parent: frame, kind: "authcrypt", mid: "m3" });
    const signed = await next("envelope", "envelope.open", { parent: auth, kind: "signed" });
    const plain = await next("envelope", "envelope.open", { parent: signed, kind: "plain" });

    // the answer and what came out of it belong to every message the frame carried; the other message's seal and what is inside it do not
    expect((await trace.traceOf("m1")).map((e) => e.eid)).toEqual([out, sealOne, answer, answerBytes, opened, ritual]);
    expect((await trace.traceOf("m2")).map((e) => e.eid)).toEqual([out, sealTwo, signedTwo, answer, answerBytes, opened, ritual]);
    // two envelopes deep under the end, both taken
    expect((await trace.traceOf("m3")).map((e) => e.eid)).toEqual([frame, auth, signed, plain]);
  });

  it("policy levels: off is all zero, verbose keeps longer than normal", () => {
    expect(Object.values(tracePolicy("off").streams).every((s) => s.keepMs === 0)).toBe(true);
    expect(tracePolicy("normal")).toBe(TRACE_NORMAL);
    for (const stream of Object.keys(TRACE_NORMAL.streams) as TraceStream[]) {
      expect(tracePolicy("verbose").streams[stream].keepMs).toBeGreaterThan(TRACE_NORMAL.streams[stream].keepMs);
    }
    expect(traceLevelOf(null)).toBe("normal");
    expect(traceLevelOf({ trace: "verbose" })).toBe("verbose");
    expect(traceLevelOf({ trace: 3 })).toBe("normal");
  });

  it("the level lives in options.json: read at open, written by setLevel beside what else is there, pruned at once", async () => {
    const c = clock("2026-08-29T10:00:00.000Z");
    const { backend, seedKey, agent } = await scene(c);
    const trace = await AgentTrace.open(agent, { clock: c.now });
    expect(trace.level).toBe("normal");
    expect(trace.policy).toBe(TRACE_NORMAL);
    await agent.writeOptions({ other: 1 });
    await trace.append("wire.bytes", "wire.in", { body: "…" });

    const reports = await trace.setLevel("off");
    expect(trace.level).toBe("off");
    expect(trace.enabled("wire.bytes")).toBe(false);
    expect(reports.find((r) => r.stream === "wire.bytes")).toMatchObject({ byKeep: 1 });
    expect(await backend.list(`${TRACE}/wire.bytes`)).toEqual([]);
    expect(await agent.readOptions()).toEqual({ other: 1, trace: "off" });

    // another open of the folder finds it
    const again = await openVault(backend, seedKey, { clock: c.now });
    expect((await AgentTrace.open(again.vault.local("agent"))).level).toBe("off");
    // back up, and a bent value is no level
    await trace.setLevel("verbose");
    expect((await AgentTrace.open(agent)).policy).toBe(tracePolicy("verbose"));
    await agent.writeOptions({ trace: 3 });
    expect((await AgentTrace.open(agent)).level).toBe("normal");
  });
});
