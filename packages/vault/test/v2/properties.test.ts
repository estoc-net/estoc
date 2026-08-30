import { beforeAll, describe, expect, it } from "vitest";

import { VaultFold } from "../../src/v2/index.js";
import { DEV_A, buildScene, dump, shuffle, type Scene } from "./helpers.js";

let scene: Scene;
let whole: unknown;

function foldOf(events: Scene["events"]): VaultFold {
  const fold = new VaultFold(DEV_A);
  for (const event of events) {
    fold.apply(event);
  }
  return fold;
}

beforeAll(async () => {
  scene = await buildScene();
  whole = dump(foldOf(scene.events));
});

describe("v2 fold: principle 6 (event-store.md §1)", () => {
  it("shuffled arrival folds to the same projection", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      expect(dump(foldOf(shuffle(scene.events, seed))), `seed ${seed}`).toEqual(whole);
    }
  });

  it("incremental equals whole: every prefix then the rest", () => {
    const fold = new VaultFold(DEV_A);
    for (const event of scene.events.slice(0, 10)) {
      fold.apply(event);
    }
    dump(fold); // force a projection mid-way: applying more must invalidate it
    for (const event of scene.events.slice(10)) {
      fold.apply(event);
    }
    expect(dump(fold)).toEqual(whole);
  });

  it("merge commutes: the two halves in either order, interleaved or not", () => {
    const a = scene.events.filter((event) => event.author === "aaaaaa");
    const b = scene.events.filter((event) => event.author !== "aaaaaa");
    expect(dump(foldOf([...a, ...b]))).toEqual(whole);
    expect(dump(foldOf([...b, ...a]))).toEqual(whole);
  });

  it("applying an event twice is once: identity is the eid", () => {
    const fold = foldOf(scene.events);
    for (const event of shuffle(scene.events, 9).slice(0, 20)) {
      expect(fold.apply(event)).toBe(false);
    }
    expect(dump(fold)).toEqual(whole);
    expect(fold.size).toBe(scene.events.length);
  });
});
