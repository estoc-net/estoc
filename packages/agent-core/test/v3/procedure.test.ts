import { describe, expect, it } from "vitest";

import { serially } from "../../src/v3/index.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("serially", () => {
  it("runs the work of one key in the order it was asked, a rejection holding up nothing after it, and keys apart", async () => {
    const owner = {};
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = serially(owner, "a", async () => {
      await held;
      order.push("a1");
      return 1;
    });
    const second = serially(owner, "a", async () => {
      order.push("a2");
      throw new Error("a2 failed");
    });
    const third = serially(owner, "a", async () => {
      order.push("a3");
      return 3;
    });
    const elsewhere = serially(owner, "b", async () => {
      order.push("b1");
      return "b";
    });
    await elsewhere;
    expect(order).toEqual(["b1"]);
    release();
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toThrow("a2 failed");
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(["b1", "a1", "a2", "a3"]);
    await tick();
    expect(await serially(owner, "a", async () => order.length)).toBe(4);
  });

  it("keeps a caller queued behind a tail that settled while it waited, and holds neither a key nor a result once every caller of that key has settled", async () => {
    const gc = globalThis.gc as (() => void) | undefined;
    expect(gc).toBeTypeOf("function");
    const owner = {};
    const remembered = async (n: number): Promise<WeakRef<object>> => new WeakRef(await serially(owner, `outbound ${n}`, async () => ({ n, payload: new Uint8Array(1 << 16) })));
    const results: WeakRef<object>[] = [];
    for (let n = 0; n < 12; n++) results.push(await remembered(n));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const order: number[] = [];
    const slow = serially(owner, "outbound", async () => {
      await held;
      order.push(1);
    });
    await tick();
    const queued = serially(owner, "outbound", async () => {
      order.push(2);
    });
    release();
    await slow;
    await queued;
    expect(order).toEqual([1, 2]);
    for (let round = 0; round < 5; round++) {
      await tick();
      gc?.();
    }
    expect(results.filter((reference) => reference.deref() !== undefined)).toHaveLength(0);
  });
});
