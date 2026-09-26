import { describe, expect, it } from "vitest";

import { holdOf } from "../src/core/hold.js";

describe("the hold an event carried", () => {
  it("is the name the daemon gave, and null where the event carried none or nothing that names a vault", () => {
    expect(holdOf("019b0000-0000-7000-8000-0000000000aa")).toBe("019b0000-0000-7000-8000-0000000000aa");
    expect(holdOf(null)).toBeNull();
    expect(holdOf(undefined)).toBeNull();
    expect(holdOf("")).toBeNull();
    expect(holdOf(7)).toBeNull();
  });
});
