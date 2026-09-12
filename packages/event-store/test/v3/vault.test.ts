import { describe, expect, it } from "vitest";

import {
  DamagedObject,
  DigestMismatch,
  ForkedAuthor,
  InvalidCid,
  InvalidEvent,
  MemoryEventStore,
  MemoryObjectStore,
  MemoryVault,
  MissingRoot,
  NotAVault,
  ObjectTooLarge,
  Runtime,
  UnreferencedObject,
  UnsupportedOperation,
  WriterLock,
  type Cid,
  type Collected,
  type Draft,
  type Event,
  type Held,
  type Stores,
  type VaultMetadata,
  type WrappedSeed,
} from "../../src/v3/index.js";
import { META, REWRAPPED, WRAPPED, all, authorN, clock, expectBytes } from "./suite/helpers.js";
import { EMPTY_CID, HELLO_CID, bytesOf, chunked, cidOf, drain, join } from "./suite/object-store-suite.js";

const T0 = "2026-09-07T10:00:00.000Z";
const HELLO = new TextEncoder().encode("hello");
const WORLD = new TextEncoder().encode("world");
const WORLD_CID = cidOf(WORLD);

const draft = (roots: Cid[] = [], data: Record<string, unknown> = {}): Draft => ({ type: "test.event", roots, data: { n: 1, ...data } });

/** A promise the test opens by hand. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** `bytes` as a source that yields its first byte, then waits at `g` before the rest. */
async function* gated(bytes: Uint8Array, g: { wait: Promise<void> }): AsyncIterable<Uint8Array> {
  yield bytes.slice(0, 1);
  await g.wait;
  yield bytes.slice(1);
}

/** Let everything already runnable run. */
async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

/** Has `p` settled by the time the runnable work has run? */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  await tick();
  return done;
}

/** Every root of every event in the vault: the type-independent keep set. */
async function rootsOf(held: Held): Promise<Cid[]> {
  const roots: Cid[] = [];
  for await (const event of held.events.scan()) roots.push(...event.roots);
  return roots;
}

/** Every root but `except`: what a fold that had erased that object would compute. */
function rootsExcept(except: Cid): (held: Held) => Promise<Cid[]> {
  return async (held) => (await rootsOf(held)).filter((cid) => cid !== except);
}

function open(): { vault: MemoryVault; now: ReturnType<typeof clock> } {
  const now = clock(T0);
  const vault = new MemoryVault({ metadata: META, wrapped: WRAPPED, now: now.now, author: authorN(1) });
  return { vault, now };
}

/** A stream drained after its object may have been collected or replaced: complete with exactly `bytes`, or failed — never anything else. */
async function completeOrFailed(stream: ReadableStream<Uint8Array>, bytes: Uint8Array): Promise<"complete" | "failed"> {
  let drained: Uint8Array;
  try {
    drained = (await drain(stream)).bytes;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return "failed";
  }
  expectBytes(drained, bytes);
  return "complete";
}

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
  it("exposes the metadata and the read half of the stores; every local write is a commit", async () => {
    const { vault } = open();
    const v = vault.vault;
    expect(v.metadata).toEqual(META);
    expect(Object.isFrozen(v.metadata)).toBe(true);
    expect(vault.metadata).toBe(v.metadata);
    expect(Object.keys(v.events).sort()).toEqual(["changes", "conflicting", "damaged", "scan"]);
    expect("append" in v.events).toBe(false);
    expect("appendAll" in v.events).toBe(false);
    expect("ingest" in v.events).toBe(false);
    expect(Object.keys(v.objects).sort()).toEqual(["has", "list", "open", "read", "stat"]);
    expect("putRaw" in v.objects).toBe(false);
    expect("putObject" in v.objects).toBe(false);
    expect("collect" in v.objects).toBe(false);
    expect("files" in v).toBe(false);
    expect("locked" in v).toBe(false);
    expect("ingest" in v).toBe(false);
    expect("collect" in v).toBe(false);
    expect("keystore" in v).toBe(false);
    const [event] = await v.commit([], [draft()]);
    expect(event?.author).toBe(vault.author);
    expect(await all(v.events.scan())).toEqual([event]);
  });

  it("carries the replica context — author and generation — and refuses metadata that is not a version-3 anchor", () => {
    const { vault } = open();
    expect(vault.author).toBe(authorN(1));
    expect(typeof vault.generation).toBe("string");
    expect(new MemoryVault({ metadata: META }).author).not.toBe(new MemoryVault({ metadata: META }).author);
    expect(() => new MemoryVault({ metadata: { version: 2, anchor: META.anchor } as unknown as VaultMetadata })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: { version: 3, anchor: "z6Mk" } })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: { version: 3, anchor: "did:" } })).toThrow(NotAVault);
    expect(() => new MemoryVault({ metadata: null as unknown as VaultMetadata })).toThrow(NotAVault);
  });
});

describe("Vault.commit", () => {
  it("accepts the objects, checks the roots, appends the batch under one `at`, in input order", async () => {
    const { vault } = open();
    const v = vault.vault;
    const events = await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: chunked(WORLD, [2, 2]) },
      ],
      [draft([HELLO_CID, WORLD_CID], { i: 0 }), draft([WORLD_CID], { i: 1 }), draft([], { i: 2 })]
    );
    expect(events.map((e) => e.data.i)).toEqual([0, 1, 2]);
    expect(new Set(events.map((e) => e.at)).size).toBe(1);
    expect(events[0]?.at).toBe(T0);
    expect(events.every((e) => e.author === vault.author)).toBe(true);
    expect(events[0]?.roots).toEqual([HELLO_CID, WORLD_CID]);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.stat(WORLD_CID)).toEqual({ cid: WORLD_CID, codec: "raw", size: 5 });
    expectBytes(await v.objects.read(WORLD_CID, 5), WORLD);
    expectBytes((await drain((await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>)).bytes, HELLO);
    expect((await all(v.events.scan())).map((e) => e.eventId)).toEqual(events.map((e) => e.eventId).sort());
  });

  it("with no objects, a reused root that is present passes; an absent root is MissingRoot and appends nothing", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await v.commit([], [draft([HELLO_CID], { reused: true })]);
    await expect(v.commit([], [draft([HELLO_CID]), draft([WORLD_CID])])).rejects.toThrow(MissingRoot);
    await expect(v.commit([], [draft([WORLD_CID])])).rejects.toMatchObject({ name: "MissingRoot", cid: WORLD_CID });
    expect((await all(v.events.scan())).length).toBe(2);
  });

  it("an object that fails verification publishes nothing: no event, and not the objects accepted before it", async () => {
    const { vault } = open();
    const v = vault.vault;
    await expect(
      v.commit(
        [
          { cid: HELLO_CID, source: HELLO },
          { cid: WORLD_CID, source: HELLO },
        ],
        [draft([HELLO_CID]), draft([WORLD_CID])]
      )
    ).rejects.toThrow(DigestMismatch);
    expect(await all(v.events.scan())).toEqual([]);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await all(v.objects.list())).toEqual([]);
    expect(await vault.collect(rootsOf)).toEqual({ removed: [] });
  });

  it("a root still absent after the supplied objects are accepted publishes nothing, the accepted objects included", async () => {
    const { vault } = open();
    const v = vault.vault;
    await expect(v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID, WORLD_CID])])).rejects.toThrow(MissingRoot);
    expect(await all(v.events.scan())).toEqual([]);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
  });

  it("a supplied object no draft names as a root is UnreferencedObject: refused before its source is read, and nothing of the batch is accepted", async () => {
    const { vault } = open();
    const v = vault.vault;
    let read = 0;
    const counted = async function* (bytes: Uint8Array): AsyncIterable<Uint8Array> {
      read += 1;
      yield bytes;
    };
    await expect(v.commit([{ cid: HELLO_CID, source: counted(HELLO) }], [draft()])).rejects.toThrow(UnreferencedObject);
    await expect(v.commit([{ cid: HELLO_CID, source: counted(HELLO) }], [draft([WORLD_CID])])).rejects.toMatchObject({ name: "UnreferencedObject", cid: HELLO_CID });
    await expect(
      v.commit(
        [
          { cid: WORLD_CID, source: counted(WORLD) },
          { cid: HELLO_CID, source: counted(HELLO) },
        ],
        [draft([WORLD_CID])]
      )
    ).rejects.toThrow(UnreferencedObject);
    expect(read).toBe(0);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(await all(v.events.scan())).toEqual([]);
    // named by any draft of the batch, not necessarily the first
    const events = await v.commit([{ cid: HELLO_CID, source: counted(HELLO) }], [draft(), draft([HELLO_CID])]);
    expect(events.length).toBe(2);
    expect(read).toBe(1);
  });

  it("checks every draft and every CID before reading a byte: a bad draft or a bad CID accepts nothing", async () => {
    const { vault } = open();
    const v = vault.vault;
    let read = 0;
    const counted = async function* (): AsyncIterable<Uint8Array> {
      read += 1;
      yield HELLO;
    };
    await expect(v.commit([{ cid: HELLO_CID, source: counted() }], [draft([HELLO_CID]), { type: "", data: {} }])).rejects.toThrow(InvalidEvent);
    await expect(
      v.commit(
        [
          { cid: HELLO_CID, source: counted() },
          { cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" as Cid, source: WORLD },
        ],
        [draft([HELLO_CID])]
      )
    ).rejects.toThrow(InvalidCid);
    await expect(v.commit([{ cid: HELLO_CID, source: counted() }], [draft([HELLO_CID], { data: { a: undefined } })])).rejects.toThrow(InvalidEvent);
    expect(read).toBe(0);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(await all(v.events.scan())).toEqual([]);
  });

  it("the batch is all or nothing: an invalid draft anywhere in it commits none", async () => {
    const { vault } = open();
    const v = vault.vault;
    await expect(v.commit([], [draft(), draft(), { type: "x", roots: ["nope" as Cid], data: {} }])).rejects.toThrow(InvalidEvent);
    expect(await all(v.events.scan())).toEqual([]);
    const events = await v.commit([], [draft(), draft(), draft()]);
    expect(events.length).toBe(3);
    expect(new Set(events.map((e) => e.at)).size).toBe(1);
  });

  it("an empty commit writes nothing and returns []", async () => {
    const { vault } = open();
    expect(await vault.vault.commit([], [])).toEqual([]);
    expect(await all(vault.vault.events.scan())).toEqual([]);
  });

  it("an object already held is accepted again idempotently, and the empty object is an object", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: EMPTY_CID, source: new Uint8Array(0) },
      ],
      [draft([HELLO_CID, EMPTY_CID])]
    );
    expect(await all(v.objects.list())).toEqual([HELLO_CID, EMPTY_CID].sort());
    expectBytes(await v.objects.read(EMPTY_CID, 0), new Uint8Array(0));
  });

  it("a root known damaged fails the commit explicitly and appends nothing; a commit that supplies its verified bytes repairs it and lands", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    vault.stores.objects.damage(HELLO_CID);
    await expect(v.objects.read(HELLO_CID, 5)).rejects.toThrow(DamagedObject);
    await expect(v.commit([], [draft([HELLO_CID])])).rejects.toThrow(DamagedObject);
    expect((await all(v.events.scan())).length).toBe(1);
    await expect(v.objects.has(HELLO_CID)).rejects.toThrow(DamagedObject);
    const events = await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    expect(events.length).toBe(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expectBytes(await v.objects.read(HELLO_CID, 5), HELLO);
    expect((await all(v.events.scan())).length).toBe(2);
  });

  it("a commit that fails after repairing a damaged object leaves the damage as it was", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    vault.stores.objects.damage(HELLO_CID);
    await expect(v.objects.read(HELLO_CID, 5)).rejects.toThrow(DamagedObject);
    await expect(v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID, WORLD_CID])])).rejects.toThrow(MissingRoot);
    await expect(v.objects.has(HELLO_CID)).rejects.toThrow(DamagedObject);
    expect((await all(v.events.scan())).length).toBe(1);
  });

  it("a commit's objects are seen by no read until its events land: not while a source is paused, and never when the commit fails", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]);
    vault.stores.objects.damage(WORLD_CID);
    await expect(v.objects.read(WORLD_CID, 5)).rejects.toThrow(DamagedObject); // known damaged from here on
    const g = gate();
    const committing = v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: EMPTY_CID, source: gated(new Uint8Array(0), g) },
        { cid: WORLD_CID, source: HELLO },
      ],
      [draft([HELLO_CID, WORLD_CID, EMPTY_CID])]
    );
    await tick();
    expect(vault.lock.held).toBe(true);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(await v.objects.stat(HELLO_CID)).toBeNull();
    await expect(all(v.objects.list())).rejects.toThrow(DamagedObject); // still the store as it was: WORLD damaged, no HELLO
    expect(await all(v.events.scan())).toHaveLength(1);
    g.open();
    await expect(committing).rejects.toThrow(DigestMismatch); // WORLD's bytes were not its
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    await expect(v.objects.has(WORLD_CID)).rejects.toThrow(DamagedObject);
    expect(await all(v.events.scan())).toHaveLength(1);
    // the same batch, sound: nothing visible while paused, everything at once when it lands
    const g2 = gate();
    const landing = v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
        { cid: EMPTY_CID, source: gated(new Uint8Array(0), g2) },
      ],
      [draft([HELLO_CID, WORLD_CID, EMPTY_CID])]
    );
    await tick();
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    await expect(v.objects.has(WORLD_CID)).rejects.toThrow(DamagedObject); // the repair is prepared, not published
    g2.open();
    expect(await landing).toHaveLength(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expectBytes(await v.objects.read(WORLD_CID, 5), WORLD);
    expect(await all(v.objects.list())).toEqual([HELLO_CID, WORLD_CID, EMPTY_CID].sort());
    expect(await all(v.events.scan())).toHaveLength(2);
  });

  it("a failing commit undoes only itself: damage a reader found meanwhile stays known, and a reused root known damaged still fails", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    vault.stores.objects.damage(HELLO_CID);
    const reader = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>; // opened before anything found the damage
    const g = gate();
    const failing = v.commit([{ cid: WORLD_CID, source: gated(HELLO, g) }], [draft([WORLD_CID])]);
    await tick();
    await expect(drain(reader)).rejects.toThrow(DamagedObject); // found while the commit is paused
    await expect(v.objects.has(HELLO_CID)).rejects.toThrow(DamagedObject);
    g.open();
    await expect(failing).rejects.toThrow(DigestMismatch);
    await expect(v.objects.has(HELLO_CID)).rejects.toThrow(DamagedObject);
    await expect(v.objects.stat(HELLO_CID)).rejects.toThrow(DamagedObject);
    await expect(v.commit([], [draft([HELLO_CID])])).rejects.toThrow(DamagedObject);
    expect(await all(v.events.scan())).toHaveLength(1);
  });

  it("the batch is fixed before a byte is read: an object a source adds to the array, or a descriptor it rewrites, is not accepted", async () => {
    const { vault } = open();
    const v = vault.vault;
    const objects: { cid: Cid; source: Uint8Array | AsyncIterable<Uint8Array> }[] = [];
    const growing = async function* (): AsyncIterable<Uint8Array> {
      objects.push({ cid: WORLD_CID, source: WORLD });
      yield HELLO;
    };
    objects.push({ cid: HELLO_CID, source: growing() });
    const events = await v.commit(objects, [draft([HELLO_CID])]);
    expect(events).toHaveLength(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await all(v.objects.list())).toEqual([HELLO_CID]);
    // a later descriptor rewritten while the first streams: what was checked is what is read
    const batch: { cid: Cid; source: Uint8Array | AsyncIterable<Uint8Array> }[] = [];
    let readEmpty = 0;
    const rewriting = async function* (): AsyncIterable<Uint8Array> {
      (batch[1] as { cid: Cid; source: Uint8Array }).cid = WORLD_CID;
      (batch[1] as { cid: Cid; source: Uint8Array }).source = WORLD;
      yield HELLO;
    };
    const emptyCounted = async function* (): AsyncIterable<Uint8Array> {
      readEmpty += 1;
    };
    batch.push({ cid: HELLO_CID, source: rewriting() }, { cid: EMPTY_CID, source: emptyCounted() });
    expect(await v.commit(batch, [draft([HELLO_CID, EMPTY_CID])])).toHaveLength(1);
    expect(readEmpty).toBe(1);
    expect(await v.objects.has(EMPTY_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
  });
});

describe("Vault.objects reads", () => {
  it("read refuses an object over maxBytes before reading it, returns null for an absent one, and checks the CID first", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await expect(v.objects.read(HELLO_CID, 4)).rejects.toThrow(ObjectTooLarge);
    expectBytes(await v.objects.read(HELLO_CID, 5), HELLO);
    expect(await v.objects.read(WORLD_CID, 100)).toBeNull();
    await expect(v.objects.read("bafybadcid" as Cid, 100)).rejects.toThrow(InvalidCid);
    await expect(v.objects.read(HELLO_CID, -1)).rejects.toThrow(RangeError);
    await expect(v.objects.open("bafybadcid" as Cid)).rejects.toThrow(InvalidCid);
  });

  it("a damaged object fails its read and its stream, and is known damaged from then on: presence fails too, never reads as absence", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    vault.stores.objects.damage(HELLO_CID);
    await expect(v.objects.read(HELLO_CID, 5)).rejects.toThrow(DamagedObject);
    await expect(v.objects.has(HELLO_CID)).rejects.toThrow(DamagedObject);
    await expect(v.objects.stat(HELLO_CID)).rejects.toThrow(DamagedObject);
    await expect(v.objects.open(HELLO_CID)).rejects.toThrow(DamagedObject);
    await expect(all(v.objects.list())).rejects.toThrow(DamagedObject);
  });

  it("read holds no lock while draining", async () => {
    const { vault } = open();
    const v = vault.vault;
    const big = bytesOf(3 * 1024 * 1024, 7);
    const cid = cidOf(big);
    await v.commit([{ cid, source: big }], [draft([cid])]);
    const reading = v.objects.read(cid, big.length);
    // a commit issued while the read is in flight lands
    await v.commit([], [draft()]);
    expectBytes(await reading, big);
  });
});

describe("collection", () => {
  it("a paused stream blocks no commit; collection deletes the unkept at once, whatever their age, and the stream then completes whole or fails explicitly", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
      ],
      [draft([HELLO_CID, WORLD_CID])]
    );
    const stream = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    expect(vault.lock.held).toBe(false);
    // another commit lands while the stream is paused
    const [event] = await v.commit([{ cid: EMPTY_CID, source: new Uint8Array(0) }], [draft([EMPTY_CID])]);
    expect(event).toBeDefined();
    // everything held: nothing to collect, however long it has been there
    now.advance(365 * 24 * 60 * 60 * 1000);
    expect(await vault.collect(rootsOf)).toEqual({ removed: [] });
    // a keep set without WORLD — what an erasure fold would compute — takes it at once, stream or no stream
    expect(await vault.collect(rootsExcept(WORLD_CID))).toEqual({ removed: [WORLD_CID] });
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await v.objects.open(WORLD_CID)).toBeNull();
    await completeOrFailed(stream, WORLD);
    expect(await vault.collect(rootsOf)).toEqual({ removed: [] });
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(EMPTY_CID)).toBe(true);
  });

  it("a held root known damaged survives collection with its damage; unheld, it is removed like any other and reports absence after", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
      ],
      [draft([HELLO_CID, WORLD_CID])]
    );
    const stream = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    vault.stores.objects.damage(WORLD_CID);
    await expect(drain(stream)).rejects.toThrow(DamagedObject);
    await expect(v.objects.has(WORLD_CID)).rejects.toThrow(DamagedObject);
    expect(await vault.collect(rootsOf)).toEqual({ removed: [] });
    await expect(v.objects.has(WORLD_CID)).rejects.toThrow(DamagedObject);
    expect(await vault.collect(rootsExcept(WORLD_CID))).toEqual({ removed: [WORLD_CID] });
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await v.objects.stat(WORLD_CID)).toBeNull();
    expect(await all(v.objects.list())).toEqual([HELLO_CID]);
  });

  it("two streams open before collection each get the whole object or an explicit failure; open after gets null", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const a = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
    const b = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
    expect(await vault.collect(rootsExcept(HELLO_CID))).toEqual({ removed: [HELLO_CID] });
    await completeOrFailed(a, HELLO);
    await completeOrFailed(b, HELLO);
    expect(await v.objects.open(HELLO_CID)).toBeNull();
  });

  it("open and collection racing serialize on the lock: the stream sees the object whole, or null", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    // collection first in line, with a keep computation that yields; open queued behind it
    const g = gate();
    const collecting = vault.collect(async () => {
      await g.wait;
      return [];
    });
    const opening = v.objects.open(HELLO_CID);
    expect(await settled(opening)).toBe(false);
    g.open();
    expect(await collecting).toEqual({ removed: [HELLO_CID] });
    expect(await opening).toBeNull();
    // the other order: open first, then a collection issued while it is queued
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const stream = v.objects.open(HELLO_CID);
    const collected = vault.collect(rootsExcept(HELLO_CID));
    expect(await collected).toEqual({ removed: [HELLO_CID] });
    await completeOrFailed((await stream) as ReadableStream<Uint8Array>, HELLO);
  });

  it("a paused stream resumes to completion or fails, whatever passes ran meanwhile; it never truncates", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: WORLD_CID, source: chunked(WORLD, [2, 2]) }], [draft([WORLD_CID])]);
    const stream = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const first = (await reader.read()).value as Uint8Array;
    for (let pass = 0; pass < 3; pass++) expect(await vault.collect(rootsOf)).toEqual({ removed: [] });
    expect(await vault.collect(rootsExcept(WORLD_CID))).toEqual({ removed: [WORLD_CID] });
    const rest: Uint8Array[] = [first];
    let failed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest.push(value);
      }
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      failed = true;
    }
    if (!failed) expectBytes(join(rest), WORLD);
  });

  it("collection waits for a commit paused while its objects are prepared; the event then retains the object", async () => {
    const { vault } = open();
    const v = vault.vault;
    const g = gate();
    const committing = v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: gated(WORLD, g) },
      ],
      [draft([HELLO_CID, WORLD_CID])]
    );
    await tick();
    expect(vault.lock.held).toBe(true);
    expect(await vault.stores.objects.has(HELLO_CID)).toBe(false); // verified, held by the preparation: nothing for collection to see
    const keeps: number[] = [];
    const collecting = vault.collect(async (held) => {
      keeps.push((await all(held.events.scan())).length);
      return rootsOf(held);
    });
    expect(await settled(collecting)).toBe(false);
    g.open();
    const events = await committing;
    expect(events.length).toBe(1);
    expect(await collecting).toEqual({ removed: [] });
    expect(keeps).toEqual([1]); // the keep set was computed after the commit landed
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(true);
  });

  it("the keep set is computed after the lock is acquired and held through deletion; a commit issued meanwhile starts after the pass", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const order: string[] = [];
    const g = gate();
    const collecting = vault.collect(async (held) => {
      order.push("keep in");
      expect(vault.lock.held).toBe(true);
      const roots = (await rootsOf(held)).filter((cid) => cid !== HELLO_CID);
      await g.wait;
      order.push("keep out");
      return roots;
    });
    await tick();
    const committing = v.commit([], [draft([HELLO_CID])]).then(
      (events) => {
        order.push("commit");
        return events;
      },
      (err: unknown) => {
        order.push(`commit failed: ${(err as Error).name}`);
        throw err;
      }
    );
    expect(await settled(committing)).toBe(false);
    g.open();
    expect(await collecting).toEqual({ removed: [HELLO_CID] });
    // the commit ran after the pass, and found its root gone
    await expect(committing).rejects.toThrow(MissingRoot);
    expect(order).toEqual(["keep in", "keep out", "commit failed: MissingRoot"]);
  });

  it("collection validates the keep set before touching anything", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await expect(vault.collect(() => ["not-a-cid" as Cid])).rejects.toThrow(InvalidCid);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
  });
});

describe("the held view (nested calls share the lock)", () => {
  it("an operation under the lock can commit, open, read and nest without waiting for itself", async () => {
    const { vault } = open();
    const result = await vault.locked(async (held) => {
      expect(vault.lock.held).toBe(true);
      expect(held.metadata).toBe(vault.metadata);
      const [event] = await held.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const bytes = await held.objects.read(HELLO_CID, 5);
      const stream = (await held.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
      const nested = await held.locked(async (again) => {
        expect(again).toBe(held);
        return (await all(again.events.scan())).length;
      });
      const collected = await held.collect(rootsOf);
      return { event: event as Event, bytes, stream, nested, collected };
    });
    expectBytes(result.bytes, HELLO);
    expect(result.nested).toBe(1);
    expect(result.collected).toEqual({ removed: [] });
    expect(vault.lock.held).toBe(false);
    expectBytes((await drain(result.stream)).bytes, HELLO);
  });

  it("two commits issued through one held view run one at a time, in order: the second waits for the first, and a failure undoes nothing of the one that landed", async () => {
    const { vault } = open();
    await vault.locked(async (held) => {
      const g = gate();
      const failing = held.commit([{ cid: WORLD_CID, source: gated(HELLO, g) }], [draft([WORLD_CID])]);
      const landing = held.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      expect(await settled(landing)).toBe(false); // queued behind the commit still reading its source
      expect(await held.objects.has(HELLO_CID)).toBe(false);
      g.open();
      await expect(failing).rejects.toThrow(DigestMismatch);
      const landed = await landing;
      expect(landed).toHaveLength(1);
      expect(await held.objects.has(HELLO_CID)).toBe(true);
      expect(await held.objects.has(WORLD_CID)).toBe(false);
      expect(await all(held.events.scan())).toEqual(landed);
      // and the other way round: the one that lands first lands whole, whatever fails after it
      const g2 = gate();
      const landingFirst = held.commit([{ cid: EMPTY_CID, source: gated(new Uint8Array(0), g2) }], [draft([EMPTY_CID])]);
      const failingLater = held.commit([{ cid: WORLD_CID, source: HELLO }], [draft([WORLD_CID])]);
      expect(await settled(failingLater)).toBe(false);
      g2.open();
      expect(await landingFirst).toHaveLength(1);
      await expect(failingLater).rejects.toThrow(DigestMismatch);
      expect(await held.objects.has(EMPTY_CID)).toBe(true);
      expect(await all(held.objects.list())).toEqual([HELLO_CID, EMPTY_CID].sort());
      expect(await all(held.events.scan())).toHaveLength(2);
    });
  });

  it("a commit issued through the held view while a collection pass computes its keep set lands after the pass: nothing the pass kept is what it deletes", async () => {
    const { vault } = open();
    await vault.locked(async (held) => {
      const computed = gate();
      const resume = gate();
      const keeps: Cid[][] = [];
      const collecting = held.collect(async (view) => {
        const keep = await rootsOf(view);
        keeps.push(keep);
        computed.open();
        await resume.wait;
        return keep;
      });
      await computed.wait;
      const committing = held.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      expect(await settled(committing)).toBe(false);
      expect(await held.objects.has(HELLO_CID)).toBe(false);
      resume.open();
      expect(await collecting).toEqual({ removed: [] });
      expect(await committing).toHaveLength(1);
      expect(keeps).toEqual([[]]);
      expect(await held.objects.has(HELLO_CID)).toBe(true);
      expect(await all(held.events.scan())).toHaveLength(1);
      // the next pass sees the commit and keeps its root
      expect(await held.collect(rootsOf)).toEqual({ removed: [] });
      expect(await held.objects.has(HELLO_CID)).toBe(true);
    });
  });

  it("an ingest issued through the held view queues with its commits in the order issued, its input read in its turn: neither overtakes the other", async () => {
    const { vault } = open();
    const other = new MemoryVault({ metadata: META, author: authorN(2) });
    const [foreign] = await other.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const [foreign2] = await other.vault.commit([], [draft([HELLO_CID], { n: 2 })]);
    await vault.locked(async (held) => {
      // a commit first, still reading its source: the ingest waits
      const g = gate();
      const committing = held.commit([{ cid: HELLO_CID, source: gated(HELLO, g) }], [draft([HELLO_CID])]);
      const ingesting = held.ingest([foreign]);
      expect(await settled(ingesting)).toBe(false);
      g.open();
      expect(await committing).toHaveLength(1);
      expect(await ingesting).toMatchObject({ added: 1, duplicates: 0 });
      // an ingest first, its input paused: the commit waits, and lands after it
      const entered = gate();
      const resume = gate();
      const source = (async function* () {
        entered.open();
        await resume.wait;
        yield foreign2;
      })();
      const { token } = await held.events.changes();
      const ingesting2 = held.ingest(source);
      await entered.wait;
      const committing2 = held.commit([], [draft([HELLO_CID], { n: 3 })]);
      expect(await settled(committing2)).toBe(false);
      resume.open();
      expect(await ingesting2).toMatchObject({ added: 1 });
      expect(await committing2).toHaveLength(1);
      const accepted = await all((await held.events.changes(undefined, token)).events);
      expect(accepted.map((e) => e.author)).toEqual([authorN(2), authorN(1)]);
    });
  });

  it("a mutation the operation issued and did not wait for finishes before the lock is released, even when the operation itself failed: a collection pass still reads its keep set after the failure", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await v.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]);
    const entered = gate();
    const resume = gate();
    let collecting!: Promise<Collected>;
    let heldWhileReading = false;
    const locked = vault.locked(async (held) => {
      const invalid = held.commit([], [{ type: "", data: {} } as unknown as Draft]);
      collecting = held.collect(async (view) => {
        entered.open();
        await resume.wait;
        heldWhileReading = vault.lock.held;
        return rootsExcept(WORLD_CID)(view);
      });
      return Promise.all([invalid, collecting]);
    });
    await entered.wait;
    expect(await settled(locked)).toBe(false); // the operation's own promise rejected, its collection pass has not ended
    expect(vault.lock.held).toBe(true);
    const committing = v.commit([], [draft([HELLO_CID])]);
    expect(await settled(committing)).toBe(false);
    resume.open();
    expect(await collecting).toEqual({ removed: [WORLD_CID] });
    expect(heldWhileReading).toBe(true);
    await expect(locked).rejects.toThrow(InvalidEvent);
    expect(await committing).toHaveLength(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await all(v.events.scan())).toHaveLength(3);
    expect(vault.lock.held).toBe(false);
  });

  it("a collection pass the operation issued and returned without waiting for computes its keep set after the return: its reads, nested ones included, stay good until it has deleted, and the lock is released after", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await v.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]);
    const entered = gate();
    const resume = gate();
    let collecting!: Promise<Collected>;
    let seen = 0;
    const locked = vault.locked(async (held) => {
      collecting = held.collect(async (view) => {
        entered.open();
        await resume.wait;
        seen = await view.locked(async (nested) => (await all(nested.events.scan())).length);
        expect(await view.objects.has(WORLD_CID)).toBe(true);
        return rootsExcept(WORLD_CID)(view);
      });
      return "returned";
    });
    await entered.wait;
    expect(await settled(locked)).toBe(false);
    expect(vault.lock.held).toBe(true);
    const committing = v.commit([], [draft([HELLO_CID])]);
    expect(await settled(committing)).toBe(false);
    resume.open();
    expect(await collecting).toEqual({ removed: [WORLD_CID] });
    expect(seen).toBe(2);
    expect(await locked).toBe("returned");
    expect(await committing).toHaveLength(1);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(vault.lock.held).toBe(false);
  });

  it("a collection pass still queued behind a paused commit when the operation returns gets its view when its turn comes, and reads through it", async () => {
    const { vault } = open();
    const v = vault.vault;
    const issued = gate();
    const resume = gate();
    let committing!: Promise<Event[]>;
    let collecting!: Promise<Collected>;
    let heldWhileReading = false;
    const locked = vault.locked(async (held) => {
      committing = held.commit([{ cid: HELLO_CID, source: gated(HELLO, resume) }], [draft([HELLO_CID])]);
      collecting = held.collect(async (view) => {
        heldWhileReading = vault.lock.held;
        return rootsOf(view);
      });
      issued.open();
      return "returned";
    });
    await issued.wait;
    expect(await settled(committing)).toBe(false);
    expect(await settled(collecting)).toBe(false);
    expect(await settled(locked)).toBe(false);
    expect(vault.lock.held).toBe(true);
    resume.open();
    expect(await committing).toHaveLength(1);
    expect(await collecting).toEqual({ removed: [] });
    expect(heldWhileReading).toBe(true);
    expect(await locked).toBe("returned");
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(vault.lock.held).toBe(false);
  });

  it("once the operation has returned, its view accepts no further mutation — so what the release waits on cannot grow — while its reads still land", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const entered = gate();
    const resume = gate();
    let collecting!: Promise<Collected>;
    let outer!: Held;
    const refused: string[] = [];
    let seen = 0;
    const locked = vault.locked(async (held) => {
      outer = held;
      collecting = held.collect(async (view) => {
        entered.open();
        await resume.wait;
        for (const attempt of [
          () => held.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]),
          () => held.ingest([]),
          () => held.collect(() => []),
          () => held.locked((again) => again.commit([], [draft([HELLO_CID])])),
        ]) {
          await attempt().then(
            () => refused.push("landed"),
            (err: Error) => refused.push(err.name)
          );
        }
        seen = await held.locked(async (nested) => (await all(nested.events.scan())).length);
        expect(await held.objects.has(HELLO_CID)).toBe(true);
        return rootsOf(view);
      });
      return "returned";
    });
    await entered.wait;
    expect(vault.lock.held).toBe(true);
    resume.open();
    expect(await collecting).toEqual({ removed: [] });
    expect(refused).toEqual(["UnsupportedOperation", "UnsupportedOperation", "UnsupportedOperation", "UnsupportedOperation"]);
    expect(seen).toBe(1);
    expect(await locked).toBe("returned");
    expect(vault.lock.held).toBe(false);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await all(v.events.scan())).toHaveLength(1);
    await expect(outer.objects.has(HELLO_CID)).rejects.toThrow(UnsupportedOperation);
  });

  it("a held view kept past its operation refuses every call — mutation, open, nested locked, read — before doing anything: nothing runs without the lock", async () => {
    const { vault } = open();
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    let nested = 0;
    const kept = await vault.locked(async (held) => {
      const keepView = await new Promise<Held>((resolve) => {
        void held.collect((view) => {
          resolve(view);
          return rootsOf(view);
        });
      });
      return { held, keepView };
    });
    expect(vault.lock.held).toBe(false);
    for (const view of [kept.held, kept.keepView]) {
      for (const attempt of [
        () => view.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]),
        () => view.ingest([]),
        () => view.collect(() => []),
        () => view.objects.open(HELLO_CID),
        () => view.objects.read(HELLO_CID, 5),
        () =>
          view.locked(async () => {
            nested += 1;
            return nested;
          }),
        () => view.objects.has(HELLO_CID),
        () => view.objects.stat(HELLO_CID),
        () => all(view.objects.list()),
        () => all(view.events.scan()),
        () => view.events.changes(),
        () => view.events.damaged(),
        () => view.events.conflicting(),
      ]) {
        await expect(attempt()).rejects.toThrow(UnsupportedOperation);
      }
    }
    expect(nested).toBe(0);
    expect(kept.held.metadata).toBe(vault.metadata);
    expect(await vault.vault.objects.has(WORLD_CID)).toBe(false);
    // the next operation gets a view of its own
    expect(await vault.locked((held) => held.commit([], [draft([HELLO_CID])]))).toHaveLength(1);
  });

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

  it("a keep callback's ingest is refused before its source is asked for anything: a source that counts is untouched, one that throws is never reached", async () => {
    const { vault } = open();
    let pulled = 0;
    const counting = (async function* () {
      pulled += 1;
      yield {};
    })();
    const throwing = (async function* () {
      pulled += 1;
      throw new Error("source consumed");
    })();
    const errors: string[] = [];
    expect(
      await vault.collect(async (view) => {
        for (const source of [counting, throwing]) {
          await view.ingest(source).then(
            () => errors.push("landed"),
            (err: Error) => errors.push(err.name)
          );
        }
        return [];
      })
    ).toEqual({ removed: [] });
    expect(errors).toEqual(["UnsupportedOperation", "UnsupportedOperation"]);
    expect(pulled).toBe(0);
  });

  it("a keep callback computes from reads: a commit, ingest or collect through its view is refused before touching anything", async () => {
    const { vault } = open();
    await vault.vault.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await vault.locked(async (held) => {
      const refused: string[] = [];
      const collected = await held.collect(async (view) => {
        for (const attempt of [
          () => view.commit([{ cid: WORLD_CID, source: WORLD }], [draft([WORLD_CID])]),
          () => view.ingest([]),
          () => view.collect(() => []),
          () => view.locked((again) => again.commit([], [draft([HELLO_CID])])),
        ]) {
          await attempt().then(
            () => refused.push("landed"),
            (err: Error) => refused.push(err.name)
          );
        }
        expect(await view.objects.has(HELLO_CID)).toBe(true);
        expect(view.metadata).toBe(held.metadata);
        expect(await view.locked(async (again) => (await all(again.events.scan())).length)).toBe(1);
        return rootsOf(view);
      });
      expect(refused).toEqual(["UnsupportedOperation", "UnsupportedOperation", "UnsupportedOperation", "UnsupportedOperation"]);
      expect(collected).toEqual({ removed: [] });
      expect(await held.objects.has(WORLD_CID)).toBe(false);
      expect(await all(held.events.scan())).toHaveLength(1);
    });
  });

  it("a facade operation issued while the lock is held waits for it; a failure inside releases it", async () => {
    const { vault } = open();
    const v = vault.vault;
    const g = gate();
    const order: string[] = [];
    const locked = vault.locked(async () => {
      order.push("locked in");
      await g.wait;
      order.push("locked out");
      throw new Error("boom");
    });
    await tick();
    const committing = v.commit([], [draft()]).then((events) => {
      order.push("commit");
      return events;
    });
    const collecting = vault.collect(rootsOf).then(() => order.push("collect"));
    expect(await settled(committing)).toBe(false);
    g.open();
    await expect(locked).rejects.toThrow("boom");
    await committing;
    await collecting;
    expect(order).toEqual(["locked in", "locked out", "commit", "collect"]);
    expect(vault.lock.held).toBe(false);
  });

  it("reads through the facade take no lock: a scan, stat, has and list land while an operation holds it; open does take it", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    const g = gate();
    const locked = vault.locked(() => g.wait);
    await tick();
    expect((await all(v.events.scan())).length).toBe(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.stat(HELLO_CID)).toMatchObject({ size: 5 });
    expect(await all(v.objects.list())).toEqual([HELLO_CID]);
    expect(await settled(v.objects.open(HELLO_CID))).toBe(false);
    g.open();
    await locked;
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

describe("VaultRuntime.keystore", () => {
  it("read hands out the wrapped seed as given, frozen; a vault given none refuses to read one", async () => {
    const { vault } = open();
    const wrapped = await vault.keystore.read();
    expect(wrapped).toEqual(WRAPPED);
    expect(Object.isFrozen(wrapped)).toBe(true);
    await expect(new MemoryVault({ metadata: META }).keystore.read()).rejects.toThrow(NotAVault);
  });

  it("rewrap replaces the wrapper under the lock: it waits for the operation holding it, and read sees the replacement after", async () => {
    const { vault } = open();
    const next = REWRAPPED;
    const g = gate();
    const locked = vault.locked(() => g.wait);
    await tick();
    const rewrapping = vault.keystore.rewrap(next);
    expect(await settled(rewrapping)).toBe(false);
    expect(await vault.keystore.read()).toEqual(WRAPPED);
    g.open();
    await locked;
    await rewrapping;
    expect(await vault.keystore.read()).toEqual(next);
  });

  it("rewrap refuses what is not a version-3 compact JWE before taking the lock, leaving the wrapper as it was", async () => {
    const { vault } = open();
    for (const bad of [
      { version: 2, seedJwe: WRAPPED.seedJwe },
      { version: 3, seedJwe: "not a jwe" },
      { version: 3, seedJwe: "a.b.c" },
      { version: 3, seedJwe: ".b.c.d.e" },
      { version: 3 },
      null,
    ]) {
      await expect(vault.keystore.rewrap(bad as unknown as WrappedSeed), JSON.stringify(bad)).rejects.toThrow(NotAVault);
    }
    expect(vault.lock.held).toBe(false);
    expect(await vault.keystore.read()).toEqual(WRAPPED);
    expect(() => new MemoryVault({ metadata: META, wrapped: { version: 3, seedJwe: "nope" } })).toThrow(NotAVault);
  });
});

describe("VaultRuntime.ingest", () => {
  it("ingests another replica's events under the lock; its own unseen event is ForkedAuthor", async () => {
    const other = new MemoryVault({ metadata: META, author: authorN(2), now: clock(T0).now });
    const [foreign] = await other.vault.commit([], [draft([], { from: "other" })]);
    const { vault } = open();
    const g = gate();
    const locked = vault.locked(() => g.wait);
    await tick();
    const ingesting = vault.ingest([foreign]);
    expect(await settled(ingesting)).toBe(false);
    g.open();
    await locked;
    expect(await ingesting).toEqual({ added: 1, duplicates: 0, conflicts: [], rejected: [] });
    expect(await vault.ingest([foreign])).toMatchObject({ added: 0, duplicates: 1 });
    const [own] = await vault.vault.commit([], [draft()]);
    const forked = { ...(own as Event), eventId: (foreign as Event).eventId.replace(/.$/, "f") };
    await expect(vault.ingest([forked])).rejects.toThrow(ForkedAuthor);
    expect((await all(vault.vault.events.scan())).length).toBe(2);
  });

  it("reads each input as it was yielded: a source reusing one object between yields loses nothing, on both paths", async () => {
    const other = new MemoryVault({ metadata: META, author: authorN(2), now: clock(T0).now });
    const [first, second] = (await other.vault.commit([], [draft([], { n: 1 }), draft([], { n: 2 })])) as [Event, Event];
    async function* reused(): AsyncIterable<unknown> {
      const value = structuredClone(first);
      yield value;
      Object.assign(value, structuredClone(second));
      yield value;
    }
    const direct = await new MemoryVault({ metadata: META, author: authorN(3) }).ingest(reused());
    expect(direct).toEqual({ added: 2, duplicates: 0, conflicts: [], rejected: [] });
    const held = await new MemoryVault({ metadata: META, author: authorN(3) }).locked((h) => h.ingest(reused()));
    expect(held).toEqual({ added: 2, duplicates: 0, conflicts: [], rejected: [] });
    // the same ID under two contents, through one reused object: a conflict, not a duplicate
    async function* conflicting(): AsyncIterable<unknown> {
      const value = structuredClone(first);
      yield value;
      value.data = { n: 3 };
      yield value;
    }
    const conflicted = await new MemoryVault({ metadata: META, author: authorN(3) }).ingest(conflicting());
    expect(conflicted.added).toBe(1);
    expect(conflicted.conflicts.map((c) => [c.eventId, c.kept.data, c.rejected.data])).toEqual([[first.eventId, { n: 1 }, { n: 3 }]]);
    // what the store holds is the runtime's own copy: mutating the source afterwards changes nothing
    const vault = new MemoryVault({ metadata: META, author: authorN(3) });
    const value = structuredClone(first);
    await vault.ingest([value]);
    (value.data as { n: number }).n = 99;
    expect((await all(vault.vault.events.scan()))[0]?.data).toEqual({ n: 1 });
  });

  it("an input that is not an event is reported as rejected, with why, in the order it was read", async () => {
    const other = new MemoryVault({ metadata: META, author: authorN(2), now: clock(T0).now });
    const [good] = await other.vault.commit([], [draft()]);
    async function* mixed(): AsyncIterable<unknown> {
      const bad = { ...(good as Event), at: "yesterday" };
      yield bad;
      bad.at = (good as Event).at; // mended after the fact: too late, it was read as it was yielded
      yield { ...(good as Event), data: { n: -0 } }; // a canonical form of its own: -0 becomes 0
      yield 42;
    }
    const outcome = await new MemoryVault({ metadata: META, author: authorN(3) }).ingest(mixed());
    expect(outcome.added).toBe(1);
    expect(outcome.rejected.map((r) => r.error)).toEqual(["at is not a canonical RFC 3339 UTC millisecond", "an event is a JSON object"]);
    expect(outcome.rejected[1]?.value).toBe(42);
  });

  it("the held view ingests too, for import and restore", async () => {
    const other = new MemoryVault({ metadata: META, author: authorN(2) });
    const events = await other.vault.commit([], [draft(), draft()]);
    const { vault } = open();
    const outcome = await vault.locked((held) => held.ingest(events));
    expect(outcome.added).toBe(2);
  });
});
