import { describe, expect, it } from "vitest";

import { Graph } from "../src/graph.js";
import { C } from "./facts.js";

describe("reach", () => {
  const graph = new Graph(() => true);
  const length = 1000;
  for (let i = 0; i < length; i++) graph.add(C("A", `B${i}`), C("A", `B${i + 1}`), "peer", [`p${i}`]);

  it("stops at the channel asked for and rebuilds only the path to it", () => {
    const near = graph.reach(C("A", "B0"), "any", C("A", "B1"));
    expect([...near.channels()]).toEqual([C("A", "B0"), C("A", "B1")]);
    expect(near.pathTo(C("A", "B1"))?.map((edge) => [...edge.support])).toEqual([["p0"]]);
    expect(near.pathTo(C("A", "B2"))).toBeUndefined();
    expect(graph.reach(C("A", "B0"), "any", C("A", "B0")).pathTo(C("A", "B0"))).toEqual([]);
  });

  it("reaches every channel of a long history with one entry each, and rebuilds any path on demand", () => {
    const all = graph.reach(C("A", "B0"), "any");
    expect([...all.channels()]).toHaveLength(length + 1);
    expect(all.pathTo(C("A", `B${length}`))).toHaveLength(length);
    expect(all.pathTo(C("A", "B3"))?.map((edge) => edge.to)).toEqual([C("A", "B1"), C("A", "B2"), C("A", "B3")]);
    expect(graph.path(C("A", "B0"), C("A", `B${length}`))).toHaveLength(length);
    expect(graph.path(C("A", "B5"), C("A", "B2"))).toBeNull();
  });

  it("follows only edges of the requested kind", () => {
    const mixed = new Graph(() => true);
    mixed.add(C("A0", "B0"), C("A0", "B1"), "peer", ["p"]);
    mixed.add(C("A0", "B1"), C("A1", "B1"), "local", ["d"]);
    expect([...mixed.reach(C("A0", "B0"), "peer").channels()]).toEqual([C("A0", "B0"), C("A0", "B1")]);
    expect([...mixed.reach(C("A0", "B0"), "any").channels()]).toEqual([C("A0", "B0"), C("A0", "B1"), C("A1", "B1")]);
  });
});
