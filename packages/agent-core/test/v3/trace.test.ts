import { describe, expect, it } from "vitest";

import { AgentTrace, TRACE_OPTION } from "../../src/v3/index.js";
import { freshVault } from "./helpers.js";

describe("the trace over the runtime's local state", () => {
  it("opens at the level the options name, writes the streams the level keeps, and numbers what it writes", async () => {
    const { runtime } = await freshVault();
    const trace = await AgentTrace.open(runtime.local);
    expect(trace.level).toBe("normal");
    expect(trace.enabled("bytes")).toBe(false);
    expect(await trace.append("bytes", "in", { body: "…" })).toBeUndefined();
    const first = await trace.append("wire", "in", { via: "http", bytes: 3 });
    const second = await trace.append("envelope", "open", { parent: first, type: "t", messageId: "m" });
    expect([first, second]).toEqual([1, 2]);
    expect((await trace.read({ stream: "envelope" })).map((entry) => [entry.seq, entry.type, entry.data])).toEqual([[2, "envelope.open", { parent: 1, type: "t", messageId: "m" }]]);
    expect((await trace.read({ after: 1 })).map((entry) => entry.seq)).toEqual([2]);

    await trace.setLevel("verbose");
    expect(await runtime.local.options.get(TRACE_OPTION)).toBe("verbose");
    expect(trace.enabled("bytes")).toBe(true);
    expect(await trace.append("bytes", "in", { body: "…" })).toBe(3);
    const reopened = await AgentTrace.open(runtime.local);
    expect(reopened.level).toBe("verbose");

    await trace.setLevel("off");
    expect(await trace.read()).toEqual([]);
    expect(await trace.append("wire", "in", {})).toBeUndefined();
    await runtime.close();
  });

  it("traceOf follows the onion of one message and leaves the other envelopes of the frame alone", async () => {
    const { runtime } = await freshVault();
    const trace = new AgentTrace(runtime.local, { level: "verbose" });
    const frame = await trace.append("wire", "in", { via: "ws" });
    const bytes = await trace.append("bytes", "in", { parent: frame, body: "…" });
    const mine = await trace.append("envelope", "open", { parent: frame, messageId: "M" });
    const theirs = await trace.append("envelope", "open", { parent: frame, messageId: "N" });
    const ritual = await trace.append("mediation", "in", { parent: mine, msg: {} });
    const unrelated = await trace.append("wire", "out", { via: "http" });
    expect((await trace.traceOf("M")).map((entry) => entry.seq)).toEqual([frame, bytes, mine, ritual]);
    expect((await trace.traceOf("N")).map((entry) => entry.seq)).toEqual([frame, bytes, theirs]);
    expect(await trace.traceOf("nothing")).toEqual([]);
    expect(unrelated).toBe(6);
    await runtime.close();
  });

  it("a request that names the message starts its onion too: what hangs on it comes along, and a request for another message stays out", async () => {
    const { runtime } = await freshVault();
    const trace = new AgentTrace(runtime.local, { level: "verbose" });
    const out = await trace.append("wire", "out", { via: "http", messageId: "M" });
    const bytes = await trace.append("bytes", "out", { parent: out, body: "…" });
    const answer = await trace.append("wire", "in", { via: "http", parent: out, status: 202 });
    const other = await trace.append("wire", "out", { via: "http", messageId: "N" });
    const refused = await trace.append("wire", "in", { via: "http", parent: other, status: 503 });
    await trace.append("diag", "delivery", { messageId: "M", reason: "…" });
    expect((await trace.traceOf("M")).map((entry) => entry.seq)).toEqual([out, bytes, answer]);
    expect((await trace.traceOf("N")).map((entry) => entry.seq)).toEqual([other, refused]);
    await runtime.close();
  });

  it("prunes by the level's policy", async () => {
    const { runtime } = await freshVault();
    const trace = new AgentTrace(runtime.local, { policy: { keepMs: 60_000, capRows: 2, streams: new Set(["diag"]) } });
    for (let i = 0; i < 4; i++) await trace.append("diag", "line", { i });
    expect(await trace.prune()).toEqual({ pruned: 2 });
    expect((await trace.read()).map((entry) => entry.seq)).toEqual([3, 4]);
    await runtime.close();
  });
});
