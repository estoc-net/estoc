import { describe, expect, it } from "vitest";

import { foldAuthors, foldLabel, type ContactId } from "../../src/index.js";
import { AUTHOR, AUTHOR2, Scene, expectOrderFree } from "./helpers.js";

const CONTACT = "019b2a63-48bf-7214-961d-4c3f97cb95da" as ContactId;

describe("the authors and the label", () => {
  it("reports each author's span and count, by author ID", () => {
    const scene = new Scene();
    scene.add("identity.label", { name: "Alice" }, { author: AUTHOR2, at: "2026-09-13T10:00:00.000Z" });
    scene.add("contact.created", { contactId: CONTACT, because: "user" }, { at: "2026-09-13T09:00:00.000Z" });
    scene.foreign("extension.installed", {}, { at: "2026-09-13T11:00:00.000Z" });
    scene.add("contact.deleted", { contactId: CONTACT }, { at: "2026-09-13T08:00:00.000Z" });
    expect(foldAuthors(scene.set())).toEqual([
      { author: AUTHOR, firstEventAt: "2026-09-13T08:00:00.000Z", lastEventAt: "2026-09-13T11:00:00.000Z", events: 3 },
      { author: AUTHOR2, firstEventAt: "2026-09-13T10:00:00.000Z", lastEventAt: "2026-09-13T10:00:00.000Z", events: 1 },
    ]);
    expectOrderFree(scene.events, foldAuthors);
  });

  it("takes the latest label by canonical order, and none before any", () => {
    const scene = new Scene();
    expect(foldLabel(scene.set())).toBeNull();
    scene.add("identity.label", { name: "Alice" }, { at: "2026-09-13T10:00:00.000Z" });
    scene.add("identity.label", { name: "Alicia" }, { at: "2026-09-13T09:00:00.000Z", author: AUTHOR2 });
    expect(foldLabel(scene.set())).toBe("Alice");
    expectOrderFree(scene.events, foldLabel);
  });
});
