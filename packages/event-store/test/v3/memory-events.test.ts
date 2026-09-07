import { describe, expect, it } from "vitest";

import { BadToken, MemoryEventStore } from "../../src/v3/index.js";
import { eventStoreSuite, type OpenOptions } from "./suite/event-store-suite.js";
import { all, authorN, clock } from "./suite/helpers.js";

eventStoreSuite("MemoryEventStore", async (options: OpenOptions = {}) => new MemoryEventStore(options));

describe("MemoryEventStore", () => {
  it("mints its author and generation when given none, and takes them when given", () => {
    const minted = new MemoryEventStore();
    const other = new MemoryEventStore();
    expect(minted.author).not.toBe(other.author);
    expect(minted.generation).not.toBe(other.generation);
    const given = new MemoryEventStore({ author: authorN(1), generation: "g1" });
    expect(given.author).toBe(authorN(1));
    expect(given.generation).toBe("g1");
  });

  it("hands out frozen events: what was accepted cannot be edited through the store's own return values", async () => {
    const store = new MemoryEventStore();
    const event = await store.append({ type: "t", data: { list: [1], nested: { a: 1 } } });
    expect(() => {
      (event as { type: string }).type = "changed";
    }).toThrow();
    expect(() => {
      (event.data as { list: number[] }).list.push(2);
    }).toThrow();
    const [scanned] = await all(store.scan());
    expect(Object.isFrozen(scanned)).toBe(true);
    expect(Object.isFrozen(scanned?.data)).toBe(true);
    const foreign = new MemoryEventStore();
    const [ingested] = await foreign.ingest([event]).then(() => all(foreign.scan()));
    expect(Object.isFrozen(ingested)).toBe(true);
    expect(Object.isFrozen(ingested?.data["nested"])).toBe(true);
  });

  it("a token is one generation's: another store of the same generation but another event set, or a position past what is held, is refused", async () => {
    const c = clock("2026-09-06T10:00:00.000Z");
    const store = new MemoryEventStore({ author: authorN(1), generation: "g", now: c.now });
    await store.append({ type: "t", data: {} });
    const { token } = await store.changes();
    const forged = JSON.stringify({ ...(JSON.parse(token) as object), seq: 2 });
    await expect(store.changes(undefined, forged)).rejects.toBeInstanceOf(BadToken);
    for (const seq of [-1, 1.5, "1", null]) {
      await expect(store.changes(undefined, JSON.stringify({ generation: "g", seq })), String(seq)).rejects.toBeInstanceOf(BadToken);
    }
    // the same generation string does not make another instance's token placeable here
    const twin = new MemoryEventStore({ author: authorN(2), generation: "g", now: c.now });
    await twin.append({ type: "t", data: {} });
    await twin.append({ type: "t", data: {} });
    const { token: twinToken } = await twin.changes();
    await expect(store.changes(undefined, twinToken)).rejects.toBeInstanceOf(BadToken);
    expect(await all((await store.changes(undefined, token)).events)).toEqual([]);
  });

  it("scan walks a snapshot: an append during the walk is not yielded, and a later scan has it", async () => {
    const c = clock("2026-09-06T10:00:00.000Z");
    const store = new MemoryEventStore({ now: c.now });
    await store.append({ type: "t", data: { n: 1 } });
    await store.append({ type: "t", data: { n: 2 } });
    const seen: number[] = [];
    for await (const event of store.scan()) {
      seen.push(event.data.n as number);
      if (seen.length === 1) await store.append({ type: "t", data: { n: 3 } });
    }
    expect(seen).toEqual([1, 2]);
    expect((await all(store.scan())).map((event) => event.data.n)).toEqual([1, 2, 3]);
  });

  it("writes are serialised: interleaved appends and an ingest all land; appends in issue order, the ingest once it has read its input", async () => {
    const c = clock("2026-09-06T10:00:00.000Z");
    const store = new MemoryEventStore({ author: authorN(1), now: c.now });
    const other = new MemoryEventStore({ author: authorN(2), now: c.now });
    const foreign = await other.appendAll([{ type: "f", data: {} }, { type: "f", data: {} }]);
    const results = await Promise.all([
      store.append({ type: "t", data: { n: 1 } }),
      store.ingest(foreign),
      store.appendAll([{ type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }]),
      store.append({ type: "t", data: { n: 4 } }),
    ]);
    expect(results[1]).toMatchObject({ added: 2 });
    const { events } = await store.changes();
    const order = (await all(events)).map((event) => (event.type === "f" ? "f" : event.data.n));
    expect(order.filter((x) => x !== "f")).toEqual([1, 2, 3, 4]);
    expect(order.filter((x) => x === "f")).toEqual(["f", "f"]);
    expect(await all(store.scan())).toHaveLength(6);
  });
});
