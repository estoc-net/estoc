/**
 * The runtime in memory, and what only it can show: the writer lock
 * on its own, the metadata a `MemoryVault` refuses, a `Runtime` over
 * stores that publish as they go, a guard that halts it, and the
 * keystore it was given none of. Everything a vault must do whatever
 * its backend is in `vaultSuite`, which the SQLite vault runs too.
 */

import { describe, expect, it } from "vitest";

import { DigestMismatch, MemoryEventStore, MemoryObjectStore, MemoryVault, NotAVault, Runtime, UnsupportedOperation, WriterLock, type Cid, type Draft, type Stores, type VaultMetadata } from "../../src/v3/index.js";
import { META, WRAPPED, all, authorN } from "./suite/helpers.js";
import { HELLO_CID, cidOf } from "./suite/object-store-suite.js";
import { gate, tick, vaultSuite } from "./suite/vault-suite.js";

const HELLO = new TextEncoder().encode("hello");
const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);

const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

vaultSuite("MemoryVault", async ({ author, now }) => {
  const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED, now, author });
  return { vault, corrupt: async (cid) => vault.stores.objects.damage(cid) };
});

describe("WriterLock", () => {
  it("runs operations one at a time, in arrival order, and releases on failure", async () => {
    const lock = new WriterLock();
    const order: string[] = [];
    const g = gate();
    const first = lock.run(async () => {
      order.push("first in");
      await g.wait;
      order.push("first out");
    });
    const second = lock.run(async () => {
      order.push("second");
      throw new Error("boom");
    });
    const third = lock.run(async () => {
      order.push("third");
    });
    await tick();
    expect(lock.held).toBe(true);
    expect(order).toEqual(["first in"]);
    g.open();
    await first;
    await expect(second).rejects.toThrow("boom");
    await third;
    expect(order).toEqual(["first in", "first out", "second", "third"]);
    expect(lock.held).toBe(false);
  });
});

describe("Vault facade", () => {
  it("carries the replica context — author and generation — and refuses metadata that is not a version-3 anchor", () => {
    const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED, author: authorN(1) });
    expect(vault.author).toBe(authorN(1));
    expect(typeof vault.generation).toBe("string");
    expect(new MemoryVault({ metadata: META }).author).not.toBe(new MemoryVault({ metadata: META }).author);
    expect(() => new MemoryVault({ metadata: { version: 2, anchor: META.anchor } as unknown as VaultMetadata })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: { version: 3, anchor: "z6Mk" } })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: { version: 3, anchor: "did:" } })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: null as unknown as VaultMetadata })).toThrow(NotAVault);
  });
});

describe("Runtime", () => {
  it("refuses stores without a transaction: two stores that publish as they go cannot make a vault", () => {
    const events = new MemoryEventStore({ author: authorN(1) });
    const objects = new MemoryObjectStore();
    const keystore = () => ({ read: async () => WRAPPED, rewrap: async () => undefined });
    const stores = { events, objects } as unknown as Stores;
    expect(() => new Runtime({ author: events.author, generation: events.generation, metadata: META, stores, keystore })).toThrow(TypeError);
    // the same two stores under a transaction: a commit that fails halfway leaves nothing behind
    const runtime = new Runtime({
      author: events.author,
      generation: events.generation,
      metadata: META,
      stores: {
        events,
        objects,
        transaction: async (body) => {
          const prepared = objects.prepare();
          const drafts = await body(prepared);
          return events.appendAll(drafts, () => prepared.publish());
        },
      },
      keystore,
    });
    return (async () => {
      await expect(
        runtime.vault.commit(
          [
            { cid: HELLO_CID, source: HELLO },
            { cid: WORLD_CID, source: HELLO },
          ],
          [draft([HELLO_CID, WORLD_CID])]
        )
      ).rejects.toThrow(DigestMismatch);
      expect(await runtime.vault.objects.has(HELLO_CID)).toBe(false);
      expect(await all(runtime.vault.events.scan())).toEqual([]);
    })();
  });
});

describe("Runtime guard", () => {
  it("a runtime halted after an operation ended: the facade refuses through its guard, and the operation's views refuse on their own, asking the guard nothing", async () => {
    const events = new MemoryEventStore({ author: authorN(1) });
    const objects = new MemoryObjectStore();
    let halted = false;
    const asked: string[] = [];
    const runtime = new Runtime({
      author: events.author,
      generation: events.generation,
      metadata: META,
      stores: {
        events,
        objects,
        transaction: async (body) => {
          const prepared = objects.prepare();
          const drafts = await body(prepared);
          return events.appendAll(drafts, () => prepared.publish());
        },
      },
      keystore: () => ({ read: () => Promise.reject(new NotAVault("none")), rewrap: () => Promise.resolve() }),
      guard: (when) => {
        asked.push(when);
        if (halted) throw new Error("halted");
      },
    });
    await runtime.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const kept = await runtime.locked(async (held) => held);
    halted = true;
    asked.length = 0;
    await expect(runtime.vault.objects.has(HELLO_CID)).rejects.toThrow("halted");
    await expect(all(runtime.vault.events.scan())).rejects.toThrow("halted");
    await expect(runtime.vault.events.changes()).rejects.toThrow("halted");
    expect(asked).toEqual(["read", "read", "read"]);
    await expect(kept.objects.has(HELLO_CID)).rejects.toThrow(UnsupportedOperation);
    await expect(all(kept.events.scan())).rejects.toThrow(UnsupportedOperation);
    await expect(kept.events.changes()).rejects.toThrow(UnsupportedOperation);
    expect(asked).toEqual(["read", "read", "read"]);
  });
});

describe("MemoryVault keystore", () => {
  it("a vault given no wrapped seed refuses to read one, and one given a bad wrapper refuses to be made", async () => {
    await expect(new MemoryVault({ metadata: META }).keystore.read()).rejects.toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: META, wrapped: { version: 3, seedJwe: "nope" } })).toThrow(NotAVault);
  });
});
