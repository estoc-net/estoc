import { compareEvents, type Event } from "@estoc/event-store";
import { describe, expect, it } from "vitest";

import { InvalidPayload, VaultEventSet, latest, samePayload, type ContactId, type EventReference } from "../../src/index.js";
import { AUTHOR, AUTHOR2, Scene, shuffled } from "./helpers.js";

const CONTACT = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;

describe("VaultEventSet", () => {
  it("holds each event once by ID, whatever arrives first", () => {
    const scene = new Scene();
    const a = scene.add("contact.created", { contactId: CONTACT, because: "user" });
    const set = VaultEventSet.of([a, a, { ...a, data: { contactId: CONTACT, because: "automatic" } } as Event]);
    expect(set.size).toBe(1);
    expect(set.of("contact.created")).toEqual([a]);
  });

  it("orders a type's events canonically however they were added", () => {
    const scene = new Scene();
    const first = scene.add("contact.petname", { contactId: CONTACT, name: "a" });
    const second = scene.add("contact.petname", { contactId: CONTACT, name: "b" });
    const third = scene.add("contact.petname", { contactId: CONTACT, name: "c" }, { at: second.at, author: AUTHOR2 });
    const tied = [second, third].sort(compareEvents); // one `at`: the CIDs' text order decides, not the author
    for (let seed = 1; seed <= 4; seed++) {
      const set = VaultEventSet.of(shuffled(scene.events, seed));
      expect(set.of("contact.petname").map((event) => event.data.name)).toEqual([first, ...tied].map((event) => event.data.name));
    }
    expect(latest(scene.events)).toBe(tied[1]);
    expect(first.at < second.at).toBe(true);
  });

  it("keeps an invalid event of a known type and an event of an unknown type without applying either", () => {
    const scene = new Scene();
    const good = scene.add("contact.created", { contactId: CONTACT, because: "user" });
    const bad = { ...scene.add("contact.deleted", { contactId: CONTACT }), data: { contactId: 12 } } as Event;
    const foreign = scene.foreign("extension.installed", { name: "x" });
    const set = VaultEventSet.of([good, bad, foreign]);
    expect(set.size).toBe(3);
    expect(set.of("contact.deleted")).toEqual([]);
    expect(set.invalid).toHaveLength(1);
    expect(set.invalid[0]?.event).toBe(bad);
    expect(set.invalid[0]?.error).toBeInstanceOf(InvalidPayload);
    expect([...set.unapplied()].map((event) => event.cid).sort()).toEqual([bad.cid, foreign.cid].sort());
    expect([...set.all()]).toHaveLength(3);
  });

  it("resolves a typed reference to the event of that type, to nothing, or to an event of another type", () => {
    const scene = new Scene();
    const named = scene.add("contact.petname", { contactId: CONTACT, name: "bob" });
    const other = scene.add("contact.created", { contactId: CONTACT, because: "user" });
    const foreign = scene.foreign("extension.installed");
    const set = scene.set();
    expect(set.resolve(named.cid as EventReference<"contact.petname">, "contact.petname")).toEqual({ status: "present", event: named });
    expect(set.resolve(other.cid as EventReference<"contact.petname">, "contact.petname")).toEqual({ status: "mismatched", event: other });
    expect(set.resolve(foreign.cid as EventReference<"contact.petname">, "contact.petname")).toEqual({ status: "mismatched", event: foreign });
    expect(set.resolve("019b2a99-0000-7000-8000-000000000000" as EventReference<"contact.petname">, "contact.petname")).toEqual({ status: "missing" });
  });

  it("collects authors over read and kept events alike", async () => {
    const scene = new Scene();
    scene.add("contact.created", { contactId: CONTACT, because: "user" });
    scene.foreign("extension.installed", {}, { author: AUTHOR2 });
    const set = await VaultEventSet.from(
      (async function* () {
        yield* scene.events;
      })()
    );
    expect([...set.authors()].sort()).toEqual([AUTHOR, AUTHOR2]);
  });

  it("compares payloads as canonical JSON", () => {
    expect(samePayload({ b: 1, a: [1, { d: 2, c: 3 }] }, { a: [1, { c: 3, d: 2 }], b: 1 })).toBe(true);
    expect(samePayload({ a: 1 }, { a: 1, b: null })).toBe(false);
    expect(latest([])).toBeNull();
  });
});
