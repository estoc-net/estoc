import { describe, expect, it } from "vitest";

import { canonicalFact, emptySnapshot, IncompatibleSnapshot, InvalidFact, mergeFacts, normalizeSnapshot, sameFacts, validateFact, type ContinuityFact, type FactSnapshot } from "../src/index.js";
import { C, decide, observe, permutations, rotate, snapshot } from "./facts.js";

const p1 = rotate("p1", C("A0", "B0"), "B1");
const p1variant = rotate("p1", C("A0", "B0"), "B2");
const o1 = observe("o1", C("A0", "B1"), "p1", "receipt-p1");
const d1 = decide("d1", C("A0", "B0"), "A1", "o0");
const o0 = observe("o0", C("A0", "B0"));

const A = snapshot([p1, o1]);
const B = snapshot([p1variant, d1]);
const D = snapshot([o0, p1]);

describe("merge laws", () => {
  it("is commutative", () => {
    expect(sameFacts(mergeFacts(A, B), mergeFacts(B, A))).toBe(true);
    expect(mergeFacts(A, B)).toEqual(mergeFacts(B, A));
  });

  it("is associative", () => {
    expect(mergeFacts(mergeFacts(A, B), D)).toEqual(mergeFacts(A, mergeFacts(B, D)));
  });

  it("is idempotent", () => {
    expect(mergeFacts(A, A)).toEqual(normalizeSnapshot(A));
    const merged = mergeFacts(A, B);
    expect(mergeFacts(merged, merged)).toEqual(merged);
    expect(mergeFacts(merged, A)).toEqual(merged);
  });

  it("has the empty snapshot as identity", () => {
    expect(mergeFacts(A, emptySnapshot("alice"))).toEqual(normalizeSnapshot(A));
    expect(mergeFacts(emptySnapshot("alice"), emptySnapshot("alice"))).toEqual(emptySnapshot("alice"));
  });

  it("gives the same result whatever the delivery order or batching", () => {
    const all = [A, B, D];
    const expected = mergeFacts(mergeFacts(A, B), D);
    for (const order of permutations(all)) {
      expect(order.reduce(mergeFacts)).toEqual(expected);
      expect(mergeFacts(order[0]!, mergeFacts(order[1]!, order[2]!))).toEqual(expected);
    }
    const oneByOne = A.facts.concat(B.facts, D.facts).reduce((acc, fact) => mergeFacts(acc, snapshot([fact])), emptySnapshot("alice"));
    expect(oneByOne).toEqual(expected);
  });

  it("does not mutate its inputs", () => {
    const left = snapshot([p1]);
    const right = snapshot([p1variant]);
    const leftBefore = JSON.stringify(left);
    const rightBefore = JSON.stringify(right);
    mergeFacts(left, right);
    expect(JSON.stringify(left)).toBe(leftBefore);
    expect(JSON.stringify(right)).toBe(rightBefore);
  });
});

describe("identity and equality", () => {
  it("retains every distinct value under one ID, and adds nothing for an exact duplicate", () => {
    const merged = mergeFacts(snapshot([p1]), snapshot([p1variant, { ...p1 }]));
    expect(merged.facts).toEqual([p1, p1variant]);
  });

  it("compares by canonical form: reordered object properties are the same fact", () => {
    const reordered = { receipt: p1.receipt, change: { successor: "B1", kind: "rotate" }, at: { peerDid: "B0", localDid: "A0" }, id: "p1", kind: "peer-transition" } as unknown as ContinuityFact;
    expect(canonicalFact(validateFact(reordered))).toBe(canonicalFact(p1));
    expect(mergeFacts(snapshot([p1]), snapshot([reordered])).facts).toHaveLength(1);
  });

  it("keeps string values exact: a different spelling is a different value", () => {
    const merged = mergeFacts(snapshot([p1]), snapshot([{ ...p1, receipt: "Receipt-p1" }]));
    expect(merged.facts).toHaveLength(2);
  });

  it("keeps the same change under different IDs as separate provenance", () => {
    const p2 = rotate("p2", C("A0", "B0"), "B1");
    expect(mergeFacts(snapshot([p1]), snapshot([p2])).facts).toEqual([p1, p2]);
  });

  it("enumerates IDs, then canonical values, in UTF-8 byte order", () => {
    const facts = [rotate("z", C("A0", "B0"), "B1"), rotate("\u{1F600}", C("A0", "B0"), "B1"), rotate("！", C("A0", "B0"), "B1"), rotate("a", C("A0", "B0"), "B1")];
    const merged = normalizeSnapshot(snapshot(facts));
    // U+FF01 is one UTF-16 unit above the surrogate range but encodes below U+1F600 in UTF-8
    expect(merged.facts.map((fact) => fact.id)).toEqual(["a", "z", "！", "\u{1F600}"]);
    expect(normalizeSnapshot(snapshot([p1variant, p1])).facts).toEqual([p1, p1variant]);
  });
});

describe("compatibility", () => {
  it("refuses another identity namespace without touching either input", () => {
    expect(() => mergeFacts(A, snapshot([p1], "bob"))).toThrow(IncompatibleSnapshot);
  });

  it("refuses a profile it does not implement rather than dropping unknown fields", () => {
    const newer = { ...snapshot([{ ...p1, extra: 1 } as unknown as ContinuityFact]), profileVersion: "estoc-continuity/2" };
    expect(() => mergeFacts(A, newer)).toThrow(IncompatibleSnapshot);
    expect(() => mergeFacts(newer, A)).toThrow(IncompatibleSnapshot);
  });

  it("refuses a malformed fact wherever it sits", () => {
    const malformed = (value: unknown) => snapshot([value as ContinuityFact]);
    const cases: unknown[] = [
      { ...p1, extra: true },
      { ...p1, id: "" },
      { ...p1, at: { localDid: "A0", peerDid: "A0" } },
      { ...p1, change: { kind: "rotate", successor: "B0" } },
      { ...p1, change: { kind: "rotate", successor: "A0" } },
      { ...p1, change: { kind: "end", successor: "B1" } },
      { ...d1, source: undefined },
      { ...d1, source: "d1" },
      { ...o1, carriedTransition: 1 },
      { ...o1, carriedTransition: "o1" },
      { ...o1, receipt: "\uD800" },
      { kind: "channel", id: "x" },
      "p1",
      null,
    ];
    for (const value of cases) {
      expect(() => mergeFacts(A, malformed(value)), JSON.stringify(value)).toThrow(InvalidFact);
      expect(() => mergeFacts(malformed(value), A), JSON.stringify(value)).toThrow(InvalidFact);
    }
  });

  it("requires explicit nulls", () => {
    const missingNull = { kind: "local-decision", id: "d", at: C("A0", "B0"), change: { kind: "rotate", successor: "A1" }, decision: "x" } as unknown as ContinuityFact;
    expect(() => validateFact(missingNull)).toThrow(InvalidFact);
  });

  it("reads each member once: an accessor cannot answer differently later", () => {
    let reads = 0;
    const tricky = Object.defineProperty({ ...p1 }, "receipt", {
      enumerable: true,
      get: () => (reads++ === 0 ? "first" : "second"),
    }) as ContinuityFact;
    const fact = validateFact(tricky) as typeof p1;
    expect(fact.receipt).toBe("first");
    expect(canonicalFact(fact)).toContain('"receipt":"first"');
  });

  it("validates a snapshot's shape before merging anything", () => {
    expect(() => mergeFacts(A, { identityNamespace: "alice", profileVersion: "estoc-continuity/1", facts: "p1" } as unknown as FactSnapshot)).toThrow(IncompatibleSnapshot);
    expect(() => mergeFacts(A, { identityNamespace: "", profileVersion: "estoc-continuity/1", facts: [] })).toThrow(IncompatibleSnapshot);
  });
});
