import { afterEach, describe, expect, it, vi } from "vitest";

import { useRemoval } from "../src/ui/removal.js";

const asked: string[] = [];
let answer = true;
vi.stubGlobal("confirm", (question: string) => {
  asked.push(question);
  return answer;
});

afterEach(() => {
  asked.length = 0;
  answer = true;
});

describe("a removal a screen offers", () => {
  it("asks first, and sends nothing when the person declines", async () => {
    const { failed, busy, remove } = useRemoval();
    const removal = vi.fn(async () => undefined);
    answer = false;
    await remove("Remove it?", removal);
    expect(asked).toEqual(["Remove it?"]);
    expect(removal).not.toHaveBeenCalled();
    expect(failed.value).toBeNull();
    expect(busy.value).toBe(false);
  });

  it("shows why a removal did not happen, and lets the next attempt go out clean", async () => {
    const { failed, busy, remove } = useRemoval();
    await remove("Remove it?", () => Promise.reject(new Error("that vault is gone already")));
    expect(failed.value).toBe("that vault is gone already");
    expect(busy.value).toBe(false);
    await remove("Remove it?", async () => undefined);
    expect(failed.value).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it("takes one removal at a time: a second ask while one is under way is neither put nor sent", async () => {
    const { busy, remove } = useRemoval();
    let finish!: () => void;
    const first = remove("Remove it?", () => new Promise<void>((resolve) => (finish = resolve)));
    expect(busy.value).toBe(true);
    const removal = vi.fn(async () => undefined);
    await remove("Remove it again?", removal);
    expect(asked).toEqual(["Remove it?"]);
    expect(removal).not.toHaveBeenCalled();
    finish();
    await first;
    expect(busy.value).toBe(false);
  });
});
