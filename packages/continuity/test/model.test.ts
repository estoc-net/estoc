import { describe, expect, it } from "vitest";

import { deriveContinuity, InvalidFact, mergeFacts, type Channel, type ContinuityFact, type Continuity } from "../src/index.js";
import { C, decide, localEnd, observe, peerEnd, permutations, rotate, snapshot } from "./facts.js";

const A0B0 = C("A0", "B0");
const A0B1 = C("A0", "B1");
const A1B0 = C("A1", "B0");
const A1B1 = C("A1", "B1");

/** Every query result that has a fixed shape, so two derivations can be compared whole. */
function view(model: Continuity, channels: readonly Channel[], ids: readonly string[]) {
  return {
    facts: model.facts,
    conflicts: model.conflicts(),
    heads: channels.map((channel) => model.head(channel)),
    histories: channels.map((channel) => model.history(channel)),
    confirmations: channels.map((channel) => model.confirmation(channel.localDid, channel.peerDid)),
    statuses: ids.map((id) => model.status(id)),
  };
}

function sameWhateverTheOrder(facts: readonly ContinuityFact[], channels: readonly Channel[]) {
  const ids = facts.map((fact) => fact.id);
  const expected = view(deriveContinuity(facts), channels, ids);
  for (const order of permutations(facts)) expect(view(deriveContinuity(order), channels, ids)).toEqual(expected);
  return expected;
}

describe("receiving a peer rotation", () => {
  const p1 = rotate("p1", A0B0, "B1", "receipt-1");
  const o1 = observe("o1", A0B1, "p1", "receipt-1");

  it("moves the head of the old pair to the successor pair, supported by the transition", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
    expect(model.status("p1")).toEqual({ status: "usable", support: ["p1"] });
    expect(model.status("o1")).toEqual({ status: "usable", support: ["o1", "p1"] });
  });

  it("confirms A0 in the B0 context through the successor's observation", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B1, support: ["o1", "p1"] }] });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B1, support: ["o1", "p1"] }] });
  });

  it("does not touch another relationship sharing the peer DID", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([p1, o1, observe("ox", X0B0)]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: X0B0, support: [] });
    expect(model.changes(X0B0, "peer")).toEqual([]);
    expect(model.head(C("Y0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("lists the change for supersession checks across the local-only context", () => {
    const model = deriveContinuity([p1, o1]);
    expect(model.changes(A0B0, "peer")).toEqual([{ id: "p1", at: A0B0, change: { kind: "rotate", successor: "B1" }, to: A0B1, status: { status: "usable", support: ["p1"] } }]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([p1, o1, observe("o0", A0B0)], [A0B0, A0B1]);
  });

  it("adds support, not another successor, for repeated carriers of the same proof", () => {
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, o1, p2, observe("o2", A0B1, "p2", "receipt-2")]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1", "p2"] });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: ["p1", "p2"], derived: false, usable: true }]);
  });
});

describe("local rotation and confirmation", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");

  it("is unresolved until the predecessor address is confirmed, and never falls back to absence", () => {
    const waiting = deriveContinuity([d1]);
    expect(waiting.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(waiting.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(waiting.head(C("A2", "B0"))).toEqual({ status: "no-evidence" });
    expect(waiting.status("d1")).toEqual({ status: "waiting", because: expect.stringContaining("no observation") });
    expect(waiting.localDecisions(A0B0)).toEqual([{ id: "d1", at: A0B0, change: { kind: "rotate", successor: "A1" }, to: A1B0, status: waiting.status("d1") }]);
    const confirmed = deriveContinuity([d1, o0]);
    expect(confirmed.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
  });

  it("cannot confirm itself through what it derives", () => {
    const model = deriveContinuity([d1, observe("o1", A1B0)]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A1B0, support: ["o1"] }] });
  });

  it("admits nothing from a ring of decisions confirming one another", () => {
    const d2 = decide("d2", C("A1", "B0"), "A2");
    const model = deriveContinuity([d1, d2, observe("o2", C("A2", "B0"))]);
    expect(model.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    expect(model.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d2"], missing: [] });
  });

  it("uses the exact source the host named", () => {
    const named = decide("d1", A0B0, "A1", "o0");
    expect(deriveContinuity([named, o0]).head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
    expect(deriveContinuity([named, o0]).status("d1")).toEqual({ status: "usable", support: ["d1", "o0"] });
    const missing = deriveContinuity([named]);
    expect(missing.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: ["o0"] });
    expect(missing.head(A1B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: ["o0"] });
    expect(missing.status("d1")).toEqual({ status: "unresolved", missing: ["o0"] });
    const otherPeer = deriveContinuity([named, observe("o0", C("A0", "X0"))]);
    expect(otherPeer.status("d1")).toEqual({ status: "waiting", because: expect.stringContaining("o0") });
    expect(otherPeer.head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1"], missing: [] });
    const otherLocal = deriveContinuity([named, observe("o0", C("A9", "B0"))]);
    expect(otherLocal.status("d1")).toEqual({ status: "invalid", because: expect.stringContaining("A9") });
    const notAnObservation = deriveContinuity([decide("d1", A0B0, "A1", "p"), rotate("p", A0B0, "B1")]);
    expect(notAnObservation.status("d1")).toEqual({ status: "invalid", because: expect.stringContaining("no address observation") });
  });

  it("takes a second decision for the same successor as provenance, not as a waiting fork", () => {
    const named = decide("d2", A0B0, "A1", "o-missing");
    const model = deriveContinuity([d1, o0, named]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["d1", "o0"] });
    expect(model.status("d2")).toEqual({ status: "unresolved", missing: ["o-missing"] });
    expect(deriveContinuity([d1, named]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["d1", "d2"], missing: ["o-missing"] });
  });

  it("confirms the predecessor through a usable peer successor", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const o1 = observe("o1", A0B1, "p1", "receipt-1");
    const model = deriveContinuity([p1, o1, d1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o1", "p1"] });
  });

  it("supports a confirmation with the peer path to the observer, so the support alone re-derives it", () => {
    const facts = [rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), decide("d1", A0B0, "A1", "o2")];
    const model = deriveContinuity(facts);
    const path = model.path(A0B0, A1B0);
    expect(path).toEqual({ status: "path", channels: [A0B0, A1B0], support: ["d1", "o2", "p1", "p2"] });
    expect(model.status("d1")).toEqual({ status: "usable", support: ["d1", "o2", "p1", "p2"] });
    if (path.status !== "path") throw new Error(path.status);
    const replayed = deriveContinuity(facts.filter((fact) => path.support.includes(fact.id)));
    expect(replayed.path(A0B0, A1B0)).toEqual(path);
    const unnamed = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B2"), observe("o2", C("A0", "B2")), decide("d1", A0B0, "A1")]);
    expect(unnamed.status("d1")).toEqual({ status: "usable", support: ["d1", "o2", "p1", "p2"] });
  });

  it("names no source for an ending", () => {
    expect(() => deriveContinuity([{ ...localEnd("e1", A0B0), source: "o0" }])).toThrow(InvalidFact);
  });
});

describe("both parties rotate", () => {
  const o0 = observe("o0", A0B0);
  const d1 = decide("d1", A0B0, "A1");
  const p1 = rotate("p1", A0B0, "B1");

  it("joins in the pair of both successors without fabricating a receipt to A1", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.head(A1B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(model.confirmation("A1", "B1")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o0", at: A0B0, support: ["o0"] }] });
  });

  it("confirms A1 by a later proof-free receipt from B1", () => {
    const model = deriveContinuity([o0, d1, p1, observe("o2", A1B1)]);
    expect(model.confirmation("A1", "B1")).toEqual({ status: "confirmed", observations: [{ id: "o2", at: A1B1, support: ["o2"] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o2", at: A1B1, support: ["d1", "o0", "o2", "p1"] }] });
  });

  it("offers directed usable paths that preserve roles", () => {
    const model = deriveContinuity([o0, d1, p1]);
    expect(model.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, A0B1, A1B1], support: ["d1", "o0", "p1"] });
    expect(model.path(A0B0, A0B0)).toEqual({ status: "path", channels: [A0B0], support: [] });
    expect(model.path(A0B1, A1B0)).toEqual({ status: "none" });
    expect(model.path(A1B1, A0B0)).toEqual({ status: "none" });
    expect(model.path(C("Q", "R"), A0B0)).toEqual({ status: "none" });
  });

  it("shows the join as derived links in the history", () => {
    const model = deriveContinuity([o0, d1, p1]);
    const history = model.history(A1B1);
    expect(history.links).toEqual([
      { from: A0B0, to: A0B1, replaces: "peer", support: ["p1"], derived: false, usable: true },
      { from: A0B0, to: A1B0, replaces: "local", support: ["d1", "o0"], derived: false, usable: true },
      { from: A0B1, to: A1B1, replaces: "local", support: ["d1", "o0", "p1"], derived: true, usable: true },
      { from: A1B0, to: A1B1, replaces: "peer", support: ["d1", "o0", "p1"], derived: true, usable: true },
    ]);
    expect(history.localContext).toEqual([A0B1, A1B1]);
    expect(history.peerContext).toEqual([A1B0, A1B1]);
    expect(model.history(A0B0).localContext).toEqual([A0B0, A1B0]);
    expect(model.history(A0B0).peerContext).toEqual([A0B0, A0B1]);
  });

  it("derives the same view from any enumeration order", () => {
    sameWhateverTheOrder([o0, d1, p1, observe("o2", A1B1)], [A0B0, A0B1, A1B0, A1B1]);
  });
});

describe("competing changes", () => {
  it("reports competing peer successors in one context and selects neither", () => {
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A0B0, "B2");
    const model = deriveContinuity([p1, p2]);
    expect(model.conflicts()).toEqual([
      {
        kind: "competing-changes",
        side: "peer",
        context: [A0B0],
        changes: [
          { change: { kind: "rotate", successor: "B1" }, facts: ["p1"] },
          { change: { kind: "rotate", successor: "B2" }, facts: ["p2"] },
        ],
      },
    ]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("p1")).toEqual({ status: "conflict", facts: ["p1", "p2"], because: expect.any(String) });
    expect(model.confirmation("A0", "B0")).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.path(A0B0, A0B1)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("scopes the peer's competition over the local-only context", () => {
    const o0 = observe("o0", A0B0);
    const d1 = decide("d1", A0B0, "A1");
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A1B0, "B2");
    const model = deriveContinuity([o0, d1, p1, p2]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", context: [A0B0, A1B0] }]);
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    const unlinked = deriveContinuity([p1, p2]);
    expect(unlinked.conflicts()).toEqual([]);
    expect(unlinked.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p1"] });
  });

  it("reports two saved local successors as a fork even before either is confirmed", () => {
    const d1 = decide("d1", A0B0, "A1");
    const d2 = decide("d2", A0B0, "A2");
    const model = deriveContinuity([d1, d2]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", context: [A0B0] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(model.head(A1B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(model.head(C("A2", "B0"))).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    const confirmed = deriveContinuity([d1, d2, observe("o0", A0B0)]);
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "d2"] });
    expect(confirmed.status("d1")).toMatchObject({ status: "conflict" });
  });

  it("leaves unrelated contexts usable", () => {
    const X0B0 = C("X0", "B0");
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), rotate("px", X0B0, "B1")]);
    expect(model.head(X0B0)).toEqual({ status: "head", channel: C("X0", "B1"), support: ["px"] });
  });

  it("reports a cycle", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), rotate("p2", A0B1, "B0")]);
    expect(model.conflicts()).toEqual([{ kind: "cycle", channels: [A0B0, A0B1], facts: ["p1", "p2"] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("refuses a join that would pair a DID with itself", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), rotate("p1", A0B0, "A1")]);
    expect(model.conflicts()).toEqual([{ kind: "identity-collision", channels: [A0B0, A1B0, C("A0", "A1")], facts: ["d1", "o0", "p1"] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "o0", "p1"] });
  });

  it("derives the same conflicts from any enumeration order", () => {
    sameWhateverTheOrder([rotate("p1", A0B0, "B1"), rotate("p2", A0B0, "B2"), observe("o1", A0B1, "p1", "receipt-p1")], [A0B0, A0B1]);
  });
});

describe("ending", () => {
  it("ends the head of the pair and of its local-only context", () => {
    const model = deriveContinuity([observe("o0", A0B0), decide("d1", A0B0, "A1"), peerEnd("e1", A0B0)]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A1B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.history(A1B0).endings).toEqual([{ id: "e1", at: A0B0, side: "peer", status: { status: "usable", support: ["e1"] } }]);
    expect(model.head(C("X0", "B0"))).toEqual({ status: "no-evidence" });
  });

  it("competes with a rotation of the same endpoint, whatever the order", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "peer", changes: [{ change: { kind: "end" }, facts: ["e1"] }, { change: { kind: "rotate", successor: "B1" }, facts: ["p1"] }] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["e1", "p1"] });
    sameWhateverTheOrder([peerEnd("e1", A0B0), rotate("p1", A0B0, "B1")], [A0B0, A0B1]);
  });

  it("treats rotation followed by the successor ending as forward history", () => {
    const model = deriveContinuity([rotate("p1", A0B0, "B1"), peerEnd("e1", A0B1)]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: ["e1"] });
  });

  it("applies a local ending across the peer-only context and supplies no joined head", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), rotate("p1", A0B0, "B1")]);
    expect(model.conflicts()).toEqual([]);
    expect(model.head(A0B0)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.head(A0B1)).toEqual({ status: "ended", endings: ["e1"] });
    expect(model.localDecisions(A0B1)).toEqual([{ id: "e1", at: A0B0, change: { kind: "end" }, to: null, status: { status: "usable", support: ["e1"] } }]);
  });

  it("competes with a local rotation of the same endpoint", () => {
    const model = deriveContinuity([localEnd("e1", A0B0), decide("d1", A0B0, "A1"), observe("o0", A0B0)]);
    expect(model.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local" }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "e1"] });
  });

  it("refuses an observation that claims an ending carried it", () => {
    const model = deriveContinuity([peerEnd("e1", A0B0, "receipt-1"), observe("o1", A0B1, "e1", "receipt-1")]);
    expect(model.status("o1")).toEqual({ status: "invalid", because: expect.stringContaining("ending") });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
  });
});

describe("observations", () => {
  it("must agree with the transition they claim to carry", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const cases: [ContinuityFact, string][] = [
      [observe("o1", A0B1, "p1", "receipt-2"), "another receipt"],
      [observe("o1", C("A9", "B1"), "p1", "receipt-1"), "A9"],
      [observe("o1", C("A0", "B2"), "p1", "receipt-1"), "B2"],
      [observe("o1", A0B1, "o9", "receipt-1"), "o9"],
    ];
    for (const [observation, mention] of cases) {
      const status = deriveContinuity([p1, observation]).status("o1");
      expect(status.status === "invalid" || status.status === "unresolved", JSON.stringify(observation)).toBe(true);
      expect(JSON.stringify(status)).toContain(mention);
    }
  });

  it("stays pending when its carried transition is not here, and cannot become proof-free", () => {
    const model = deriveContinuity([observe("o1", A0B1, "p1", "receipt-1")]);
    expect(model.status("o1")).toEqual({ status: "unresolved", missing: ["p1"] });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
    expect(model.head(A0B1)).toEqual({ status: "head", channel: A0B1, support: [] });
  });

  it("confirms only its exact local recipient", () => {
    const model = deriveContinuity([observe("o1", A0B0)]);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "confirmed", observations: [{ id: "o1", at: A0B0, support: ["o1"] }] });
    expect(model.confirmation("A1", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
    expect(model.confirmation("A0", "A0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("cannot restore continuation through a conflicted context", () => {
    const p1 = rotate("p1", A0B0, "B1", "receipt-1");
    const model = deriveContinuity([p1, rotate("p2", A0B0, "B2"), observe("o1", A0B1, "p1", "receipt-1"), observe("o3", A0B1)]);
    expect(model.confirmation("A0", "B1")).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("o3")).toMatchObject({ status: "conflict" });
  });
});

describe("identity conflicts", () => {
  const p1 = rotate("p1", A0B0, "B1", "receipt-1");
  const p1other = rotate("p1", A0B0, "B2", "receipt-1");

  it("retains both variants, links nothing through them and does not fall back to the predecessor", () => {
    const model = deriveContinuity([p1, p1other]);
    expect(model.conflicts()).toEqual([
      { kind: "competing-changes", side: "peer", context: [A0B0], changes: [{ change: { kind: "rotate", successor: "B1" }, facts: ["p1"] }, { change: { kind: "rotate", successor: "B2" }, facts: ["p1"] }] },
      { kind: "identity-conflict", id: "p1", variants: [p1, p1other] },
    ]);
    expect(model.status("p1")).toEqual({ status: "identity-conflict", variants: [p1, p1other] });
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1"] });
  });

  it("does not hide a collided forward change even when the variants agree on the successor", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const model = deriveContinuity([p1, twin]);
    expect(model.conflicts()).toEqual([{ kind: "identity-conflict", id: "p1", variants: [p1, twin] }]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["p1"] });
    expect(model.history(A0B0).links).toEqual([{ from: A0B0, to: A0B1, replaces: "peer", support: ["p1"], derived: false, usable: false }]);
  });

  it("lets independent unambiguous support for the same change remain usable", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, twin, p2]);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: A0B1, support: ["p2"] });
    expect(model.status("p2")).toEqual({ status: "usable", support: ["p2"] });
  });

  it("lets independent support for the same local rotation or ending establish the head, the collision kept as a diagnostic", () => {
    const d1 = decide("d1", A0B0, "A1");
    const twin = { ...d1, decision: "decision-other" };
    const o0 = observe("o0", A0B0);
    const independent = decide("independent", A0B0, "A1");
    const rotated = deriveContinuity([o0, d1, twin, independent]);
    expect(rotated.head(A0B0)).toEqual({ status: "head", channel: A1B0, support: ["independent", "o0"] });
    expect(rotated.head(A1B0)).toEqual({ status: "head", channel: A1B0, support: [] });
    expect(rotated.path(A0B0, A1B0)).toEqual({ status: "path", channels: [A0B0, A1B0], support: ["independent", "o0"] });
    expect(rotated.status("d1")).toEqual({ status: "identity-conflict", variants: [d1, twin] });
    expect(rotated.status("independent")).toEqual({ status: "usable", support: ["independent", "o0"] });
    expect(rotated.history(A0B0).links).toEqual([{ from: A0B0, to: A1B0, replaces: "local", support: ["d1", "independent", "o0"], derived: false, usable: true }]);
    expect(deriveContinuity([o0, d1, twin, decide("independent", A0B0, "A2")]).head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "independent"] });
    sameWhateverTheOrder([o0, d1, twin, independent], [A0B0, A1B0]);
    for (const [end, variant] of [
      [localEnd("e1", A0B0), { ...localEnd("e1", A0B0), decision: "decision-other" }],
      [peerEnd("e1", A0B0), { ...peerEnd("e1", A0B0), receipt: "receipt-other" }],
    ] as const) {
      const alone = deriveContinuity([end, variant]);
      expect(alone.head(A0B0)).toEqual({ status: "conflict", facts: ["e1"] });
      const ended = deriveContinuity([end, variant, { ...end, id: "independent" }]);
      expect(ended.head(A0B0)).toEqual({ status: "ended", endings: ["independent"] });
      expect(ended.status("e1")).toEqual({ status: "identity-conflict", variants: [end, variant] });
      expect(ended.status("independent")).toEqual({ status: "usable", support: ["independent"] });
      const otherSide = end.kind === "local-decision" ? peerEnd("independent", A0B0) : localEnd("independent", A0B0);
      expect(deriveContinuity([end, variant, otherSide]).head(A0B0)).toEqual({ status: "conflict", facts: ["e1"] });
    }
  });

  it("scopes a fork by the claims made in its context, not by every variant of an ID involved", () => {
    const X0Y0 = C("X0", "Y0");
    const X0Y1 = C("X0", "Y1");
    const here = rotate("p", A0B0, "B1");
    const elsewhere = rotate("p", X0Y0, "Y1");
    const fork = rotate("fork", A0B0, "B2");
    const independent = rotate("independent", X0Y0, "Y1");
    const model = deriveContinuity([here, elsewhere, fork, independent]);
    expect(model.conflicts()).toEqual([
      { kind: "competing-changes", side: "peer", context: [A0B0], changes: [{ change: { kind: "rotate", successor: "B1" }, facts: ["p"] }, { change: { kind: "rotate", successor: "B2" }, facts: ["fork"] }] },
      { kind: "identity-conflict", id: "p", variants: [here, elsewhere] },
    ]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["fork", "p"] });
    expect(model.head(A0B1)).toEqual({ status: "conflict", facts: ["fork", "p"] });
    expect(model.head(X0Y0)).toEqual({ status: "head", channel: X0Y1, support: ["independent"] });
    expect(model.path(X0Y0, X0Y1)).toEqual({ status: "path", channels: [X0Y0, X0Y1], support: ["independent"] });
    expect(model.status("independent")).toEqual({ status: "usable", support: ["independent"] });
    expect(deriveContinuity([here, elsewhere, fork]).head(X0Y0)).toEqual({ status: "conflict", facts: ["p"] });
    sameWhateverTheOrder([here, elsewhere, fork, independent], [A0B0, A0B1, X0Y0, X0Y1]);
  });

  it("applies an ending at another pair only through usable opposite-side links, and reports an ambiguous scope instead of ending", () => {
    for (const side of ["local", "peer"] as const) {
      const link = side === "local" ? rotate("p", A0B0, "B1") : decide("d", A0B0, "A1");
      const linkTwin = link.kind === "peer-transition" ? { ...link, receipt: "receipt-other" } : { ...link, decision: "decision-other" };
      const there = side === "local" ? A0B1 : A1B0;
      const end = side === "local" ? localEnd : peerEnd;
      const e = end("e", there);
      const eTwin = e.kind === "peer-transition" ? { ...e, receipt: "receipt-other" } : { ...e, decision: "decision-other" };
      const facts = [...(side === "peer" ? [observe("o0", A0B0)] : []), link, linkTwin, observe("o1", there), e, eTwin, end("independent", A0B0)];
      const model = deriveContinuity(facts);
      expect(model.head(there)).toEqual({ status: "conflict", facts: ["e", "independent"] });
      expect(model.path(A0B0, there)).toEqual({ status: "none" });
      expect(model.status("independent")).toEqual({ status: "usable", support: ["independent"] });
      expect(model.history(there).endings.map((ending) => ending.id)).toEqual(["e", "e", "independent"]);
      expect(deriveContinuity(facts.filter((fact) => fact.id !== "e")).head(there)).toEqual({ status: "conflict", facts: ["independent"] });
      expect(deriveContinuity(facts.filter((fact) => fact.id !== link.id)).head(there)).toEqual({ status: "conflict", facts: ["e"] });
      const scoped = deriveContinuity([...facts, { ...link, id: "scope" }]);
      expect(scoped.head(there)).toEqual({ status: "ended", endings: ["independent"] });
      expect(scoped.path(A0B0, there).status).toBe("path");
      expect(deriveContinuity([...facts, end("direct", there)]).head(there)).toEqual({ status: "ended", endings: ["direct"] });
      const reversed = deriveContinuity([...facts].reverse());
      expect(view(reversed, [A0B0, there], facts.map((fact) => fact.id))).toEqual(view(model, [A0B0, there], facts.map((fact) => fact.id)));
    }
  });

  it("takes the same change made usably at another pair of the context as provenance for a collided or waiting claim", () => {
    for (const side of ["local", "peer"] as const) {
      const opposite = side === "local" ? rotate("opposite", A0B0, "B1") : decide("opposite", A0B0, "A1");
      const other = side === "local" ? A0B1 : A1B0;
      const collided = side === "local" ? decide("collided", A0B0, "A1") : rotate("collided", A0B0, "B1");
      const twin = collided.kind === "peer-transition" ? { ...collided, receipt: "receipt-other" } : { ...collided, decision: "decision-other" };
      const independent = side === "local" ? decide("independent", other, "A1") : rotate("independent", other, "B1");
      const o0 = observe("o0", A0B0);
      const o1 = observe("o1", other);
      const base = [o0, o1, opposite, independent];
      const model = deriveContinuity([...base, collided, twin]);
      const support = side === "local" ? ["independent", "o1", "opposite"] : ["independent", "o0", "opposite"];
      expect(model.head(A0B0)).toEqual({ status: "head", channel: A1B1, support });
      expect(model.head(A0B0)).toEqual(deriveContinuity(base).head(A0B0));
      expect(model.path(A0B0, A1B1)).toEqual({ status: "path", channels: [A0B0, other, A1B1], support });
      expect(model.conflicts()).toEqual([{ kind: "identity-conflict", id: "collided", variants: [collided, twin] }]);
      expect(model.status("independent")).toMatchObject({ status: "usable" });
      expect(model.head(side === "local" ? A1B0 : A0B1).status).toBe("conflict");
      const fork = { ...independent, change: { kind: "rotate", successor: side === "local" ? "A2" : "B2" } } as const;
      expect(deriveContinuity([o0, o1, opposite, fork, collided, twin]).conflicts()).toMatchObject([{ kind: "competing-changes", side }, { kind: "identity-conflict" }]);
      expect(deriveContinuity([o0, o1, opposite, fork, collided, twin]).head(A0B0).status).toBe("conflict");
      expect(deriveContinuity([o0, o1, independent, collided, twin]).head(A0B0).status).toBe("conflict");
      sameWhateverTheOrder([...base, collided, twin], [A0B0, other, A1B1]);
    }
    const p = rotate("p", A0B0, "B1");
    const o = observe("o", A0B1);
    const independent = decide("independent", A0B1, "A1");
    const waiting = decide("d", A0B0, "A1", "missing");
    const covered = deriveContinuity([p, o, independent, waiting]);
    expect(covered.head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["independent", "o", "p"] });
    expect(covered.status("d")).toEqual({ status: "unresolved", missing: ["missing"] });
    expect(deriveContinuity([p, o, waiting]).head(A0B0)).toEqual({ status: "unresolved", waiting: ["d"], missing: ["missing"] });
  });

  it("cannot hide an alternative a variant creates", () => {
    const p2 = rotate("p2", A0B0, "B1", "receipt-2");
    const model = deriveContinuity([p1, p1other, p2]);
    expect(model.head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
    expect(model.status("p2")).toMatchObject({ status: "conflict" });
  });

  it("does not hide a collided local decision behind its predecessor", () => {
    const d1 = decide("d1", A0B0, "A1");
    const twin = { ...d1, decision: "decision-other" };
    const o0 = observe("o0", A0B0);
    const confirmed = deriveContinuity([o0, d1, twin]);
    expect(confirmed.status("d1")).toEqual({ status: "identity-conflict", variants: [d1, twin] });
    expect(confirmed.head(A0B0)).toEqual({ status: "conflict", facts: ["d1", "o0"] });
    expect(confirmed.head(A1B0)).toEqual({ status: "conflict", facts: ["d1", "o0"] });
    expect(confirmed.history(A0B0).links).toEqual([{ from: A0B0, to: A1B0, replaces: "local", support: ["d1", "o0"], derived: false, usable: false }]);
    const waiting = deriveContinuity([d1, twin]);
    expect(waiting.head(A0B0)).toEqual({ status: "conflict", facts: ["d1"] });
    expect(waiting.head(A1B0)).toEqual({ status: "conflict", facts: ["d1"] });
    const forked = deriveContinuity([o0, d1, decide("d1", A0B0, "A2")]);
    expect(forked.conflicts()).toMatchObject([{ kind: "competing-changes", side: "local", changes: [{ facts: ["d1"] }, { facts: ["d1"] }] }, { kind: "identity-conflict", id: "d1" }]);
    expect(forked.head(A0B0)).toEqual({ status: "conflict", facts: ["d1"] });
    sameWhateverTheOrder([o0, d1, twin], [A0B0, A1B0]);
  });

  it("reports conflict for a reference to a collided identity instead of resolving it", () => {
    const twin = { ...p1, receipt: "receipt-9" };
    const o1 = observe("o1", A0B1, "p1", "receipt-1");
    const model = deriveContinuity([p1, twin, o1]);
    expect(model.status("o1")).toEqual({ status: "conflict", facts: ["p1"], because: expect.stringContaining("p1") });
    expect(model.confirmation("A0", "B1")).toEqual({ status: "unconfirmed", unusable: ["o1"] });
    const o0 = observe("o0", A0B0);
    const o0twin = observe("o0", A0B0, null, "receipt-other");
    const withDecision = deriveContinuity([o0, o0twin, decide("d1", A0B0, "A1", "o0")]);
    expect(withDecision.status("d1")).toEqual({ status: "conflict", facts: ["o0"], because: expect.stringContaining("o0") });
    expect(withDecision.head(A0B0)).toEqual({ status: "conflict", facts: ["o0"] });
  });

  it("survives arriving in either order or through a third replica", () => {
    const left = snapshot([p1]);
    const right = snapshot([p1other]);
    const expected = view(deriveContinuity(mergeFacts(left, right).facts), [A0B0, A0B1], ["p1"]);
    expect(view(deriveContinuity(mergeFacts(right, left).facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
    const third = mergeFacts(mergeFacts(left, snapshot([])), mergeFacts(right, snapshot([])));
    expect(view(deriveContinuity(third.facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
    expect(view(deriveContinuity(mergeFacts(third, left).facts), [A0B0, A0B1], ["p1"])).toEqual(expected);
  });
});

describe("convergence and monotonicity", () => {
  it("gives the same view to replicas that hold the same facts, and a converged conflict is a converged state", () => {
    const o0 = observe("o0", A0B0);
    const d1 = decide("d1", A0B0, "A1");
    const p1 = rotate("p1", A0B0, "B1");
    const p2 = rotate("p2", A1B0, "B2");
    const replicaA = snapshot([o0, d1, p1]);
    const replicaB = snapshot([p2, o0]);
    const merged = mergeFacts(replicaA, replicaB);
    const channels = [A0B0, A0B1, A1B0, A1B1, C("A1", "B2")];
    const ids = ["o0", "d1", "p1", "p2"];
    expect(view(deriveContinuity(mergeFacts(replicaB, replicaA).facts), channels, ids)).toEqual(view(deriveContinuity(merged.facts), channels, ids));
    expect(deriveContinuity(replicaA.facts).head(A0B0)).toEqual({ status: "head", channel: A1B1, support: ["d1", "o0", "p1"] });
    expect(deriveContinuity(merged.facts).head(A0B0)).toEqual({ status: "conflict", facts: ["p1", "p2"] });
  });

  it("answers over a long rotation history", () => {
    const length = 3000;
    const facts: ContinuityFact[] = [];
    for (let i = 0; i < length; i++) facts.push(rotate(`p${String(i).padStart(4, "0")}`, C("A0", `B${i}`), `B${i + 1}`));
    const model = deriveContinuity(facts);
    const last = C("A0", `B${length}`);
    expect(model.head(A0B0)).toEqual({ status: "head", channel: last, support: facts.map((fact) => fact.id) });
    expect(model.path(A0B0, C("A0", "B1"))).toEqual({ status: "path", channels: [A0B0, C("A0", "B1")], support: ["p0000"] });
    const path = model.path(A0B0, last);
    expect(path.status === "path" && path.channels.length).toBe(length + 1);
    expect(model.confirmation("A0", "B0")).toEqual({ status: "unconfirmed", unusable: [] });
  });

  it("refuses a malformed fact without deriving anything", () => {
    expect(() => deriveContinuity([{ ...rotate("p1", A0B0, "B1"), extra: 1 } as unknown as ContinuityFact])).toThrow(InvalidFact);
  });

  it("answers unknown IDs and unknown pairs as such", () => {
    const model = deriveContinuity([]);
    expect(model.status("nope")).toEqual({ status: "unknown" });
    expect(model.head(A0B0)).toEqual({ status: "no-evidence" });
    expect(model.conflicts()).toEqual([]);
    expect(model.history(A0B0)).toEqual({ links: [], endings: [], localContext: [A0B0], peerContext: [A0B0] });
  });
});
