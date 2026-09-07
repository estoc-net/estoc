import { describe, expect, it } from "vitest";

import {
  DamagedObject,
  DigestMismatch,
  ForkedAuthor,
  InvalidCid,
  InvalidEvent,
  MemoryVault,
  MissingRoot,
  ObjectTooLarge,
  WriterLock,
  type Cid,
  type Draft,
  type Event,
  type Held,
} from "../../src/v3/index.js";
import { all, authorN, clock, expectBytes } from "./suite/helpers.js";
import { EMPTY_CID, HELLO_CID, bytesOf, chunked, cidOf, drain } from "./suite/object-store-suite.js";

const T0 = "2026-09-07T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;
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

/** Every root of every event in the vault: the type-independent keep set (dasl-objects.md §7 rule 5). */
async function rootsOf(held: Held): Promise<Cid[]> {
  const roots: Cid[] = [];
  for await (const event of held.events.scan()) roots.push(...event.roots);
  return roots;
}

function open(overrides: { graceMs?: number } = {}): { vault: MemoryVault; now: ReturnType<typeof clock> } {
  const now = clock(T0);
  const vault = new MemoryVault({ now: now.now, graceMs: overrides.graceMs ?? HOUR, author: authorN(1) });
  return { vault, now };
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

describe("Vault facade (event-store.md §10)", () => {
  it("ES-29 exposes only the read half of the stores; every local write is a commit", async () => {
    const { vault } = open();
    const v = vault.vault;
    expect(Object.keys(v.events).sort()).toEqual(["changes", "conflicting", "damaged", "scan"]);
    expect("append" in v.events).toBe(false);
    expect("appendAll" in v.events).toBe(false);
    expect("ingest" in v.events).toBe(false);
    expect(Object.keys(v.objects).sort()).toEqual(["has", "list", "open", "read", "stat"]);
    expect("putRaw" in v.objects).toBe(false);
    expect("putObject" in v.objects).toBe(false);
    expect("collect" in v.objects).toBe(false);
    expect("locked" in v).toBe(false);
    expect("ingest" in v).toBe(false);
    expect("collect" in v).toBe(false);
    const [event] = await v.commit([], [draft()]);
    expect(event?.author).toBe(vault.author);
    expect(await all(v.events.scan())).toEqual([event]);
  });

  it("carries the replica context: author and generation", () => {
    const { vault } = open();
    expect(vault.author).toBe(authorN(1));
    expect(typeof vault.generation).toBe("string");
    expect(new MemoryVault().author).not.toBe(new MemoryVault().author);
  });
});

describe("Vault.commit (event-store.md §10, dasl-objects.md §8.1)", () => {
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

  it("DO-8 an object that fails verification appends nothing; objects accepted before it stay, orphans under grace", async () => {
    const { vault, now } = open();
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
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [HELLO_CID] });
    now.advance(HOUR);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [HELLO_CID], young: [] });
  });

  it("DO-8 a root absent after acceptance appends nothing: the supplied objects are checked, the drafts' roots are what count", async () => {
    const { vault } = open();
    const v = vault.vault;
    await expect(v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([WORLD_CID])])).rejects.toThrow(MissingRoot);
    expect(await all(v.events.scan())).toEqual([]);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
  });

  it("checks every draft and every CID before reading a byte: a bad draft or a bad CID accepts nothing", async () => {
    const { vault } = open();
    const v = vault.vault;
    let read = 0;
    const counted = async function* (): AsyncIterable<Uint8Array> {
      read += 1;
      yield HELLO;
    };
    await expect(v.commit([{ cid: HELLO_CID, source: counted() }], [draft(), { type: "", data: {} }])).rejects.toThrow(InvalidEvent);
    await expect(
      v.commit(
        [
          { cid: HELLO_CID, source: counted() },
          { cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" as Cid, source: WORLD },
        ],
        [draft()]
      )
    ).rejects.toThrow(InvalidCid);
    await expect(v.commit([{ cid: HELLO_CID, source: counted() }], [draft([WORLD_CID], { data: { a: undefined } })])).rejects.toThrow(InvalidEvent);
    expect(read).toBe(0);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(await all(v.events.scan())).toEqual([]);
  });

  it("ES-3 the batch is all or nothing: an invalid draft anywhere in it commits none", async () => {
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
});

describe("Vault.objects reads (event-store.md §10, dasl-objects.md §6.3)", () => {
  it("read refuses an object over maxBytes before reading it, returns null for an absent one, and checks the CID first", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await expect(v.objects.read(HELLO_CID, 4)).rejects.toThrow(ObjectTooLarge);
    expect(vault.latches.latched()).toEqual([]);
    expectBytes(await v.objects.read(HELLO_CID, 5), HELLO);
    expect(await v.objects.read(WORLD_CID, 100)).toBeNull();
    await expect(v.objects.read("bafybadcid" as Cid, 100)).rejects.toThrow(InvalidCid);
    await expect(v.objects.read(HELLO_CID, -1)).rejects.toThrow(RangeError);
    await expect(v.objects.open("bafybadcid" as Cid)).rejects.toThrow(InvalidCid);
  });

  it("a damaged object fails its read and its stream, and leaves the accepted namespace", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    vault.stores.objects.damage(HELLO_CID);
    await expect(v.objects.read(HELLO_CID, 5)).rejects.toThrow(DamagedObject);
    expect(await v.objects.has(HELLO_CID)).toBe(false);
    expect(vault.latches.latched()).toEqual([]);
  });

  it("read holds no latch once done, and no lock while draining", async () => {
    const { vault } = open();
    const v = vault.vault;
    const big = bytesOf(3 * 1024 * 1024, 7);
    const cid = cidOf(big);
    await v.commit([{ cid, source: big }], [draft([cid])]);
    const reading = v.objects.read(cid, big.length);
    // a commit issued while the read is in flight lands
    await v.commit([], [draft()]);
    expectBytes(await reading, big);
    expect(vault.latches.latched()).toEqual([]);
  });
});

describe("latch and collection (event-store.md §10)", () => {
  it("ES-27 a paused stream blocks no commit or file write; collection skips its CID, collects another, and takes it once the stream ends", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
      ],
      [draft([HELLO_CID])]
    );
    // HELLO retained, WORLD an orphan, both past grace
    now.advance(2 * HOUR);
    const stream = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    expect(vault.latches.latched()).toEqual([WORLD_CID]);
    expect(vault.lock.held).toBe(false);
    // another handle's commit and a file write land while the stream is paused
    const [event] = await v.commit([{ cid: EMPTY_CID, source: new Uint8Array(0) }], [draft([EMPTY_CID])]);
    expect(event).toBeDefined();
    await v.files.write("notes.txt", HELLO);
    // collection skips WORLD (latched, unlisted) and can collect nothing else eligible yet: EMPTY is held, HELLO is held
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [] });
    // make HELLO unheld: a keep set without it (what an erasure fold would compute) — WORLD is still skipped
    expect(await vault.collect(async (held) => (await rootsOf(held)).filter((c) => c !== HELLO_CID))).toEqual({ unlinked: [HELLO_CID], young: [] });
    expect(await v.objects.has(WORLD_CID)).toBe(true);
    // the stream reads its whole object, then the latch is gone and the next pass takes it
    expectBytes((await drain(stream)).bytes, WORLD);
    expect(vault.latches.latched()).toEqual([]);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [WORLD_CID], young: [] });
    expect(await v.objects.has(WORLD_CID)).toBe(false);
  });

  it("ES-27 failure and cancellation each release the latch", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit(
      [
        { cid: HELLO_CID, source: HELLO },
        { cid: WORLD_CID, source: WORLD },
      ],
      [draft()]
    );
    now.advance(2 * HOUR);
    // cancellation
    const cancelled = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [WORLD_CID], young: [] });
    await cancelled.cancel();
    expect(vault.latches.latched()).toEqual([]);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [HELLO_CID], young: [] });
    // failure
    await v.commit([{ cid: WORLD_CID, source: WORLD }], [draft()]);
    now.advance(2 * HOUR);
    const failing = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    vault.stores.objects.damage(WORLD_CID);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [] });
    await expect(drain(failing)).rejects.toThrow(DamagedObject);
    expect(vault.latches.latched()).toEqual([]);
    expect(await v.objects.has(WORLD_CID)).toBe(false);
  });

  it("ES-28 open before collection gets the whole protected object; open after gets null; one stream ending does not release another's", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft()]);
    now.advance(2 * HOUR);
    const a = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
    const b = (await v.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
    expect(vault.latches.count(HELLO_CID)).toBe(2);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [] });
    expectBytes((await drain(a)).bytes, HELLO);
    expect(vault.latches.count(HELLO_CID)).toBe(1);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [] });
    expectBytes((await drain(b)).bytes, HELLO);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [HELLO_CID], young: [] });
    expect(await v.objects.open(HELLO_CID)).toBeNull();
  });

  it("ES-28 open and collection racing serialize on the lock: the stream is protected or null, never unprotected", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft()]);
    now.advance(2 * HOUR);
    // collection first in line, with a keep computation that yields; open queued behind it
    const g = gate();
    const collecting = vault.collect(async () => {
      await g.wait;
      return [];
    });
    const opening = v.objects.open(HELLO_CID);
    expect(await settled(opening)).toBe(false);
    g.open();
    expect(await collecting).toEqual({ unlinked: [HELLO_CID], young: [] });
    expect(await opening).toBeNull();
    // the other order: open first, then a collection issued while it is queued
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft()]);
    now.advance(2 * HOUR);
    const stream = v.objects.open(HELLO_CID);
    const collected = vault.collect(rootsOf);
    expect(await collected).toEqual({ unlinked: [], young: [] });
    expectBytes((await drain((await stream) as ReadableStream<Uint8Array>)).bytes, HELLO);
  });

  it("ES-30 an abandoned stream stays latched across idle time and passes; a paused one resumes to completion", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit([{ cid: WORLD_CID, source: chunked(WORLD, [2, 2]) }], [draft()]);
    const stream = (await v.objects.open(WORLD_CID)) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const first = (await reader.read()).value as Uint8Array;
    for (let day = 0; day < 3; day++) {
      now.advance(24 * HOUR);
      expect(await vault.collect(rootsOf)).toEqual({ unlinked: [], young: [] });
    }
    expect(vault.latches.latched()).toEqual([WORLD_CID]);
    const rest: Uint8Array[] = [first];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest.push(value);
    }
    expectBytes(new Uint8Array(rest.flatMap((c) => [...c])), WORLD);
    expect(vault.latches.latched()).toEqual([]);
    expect(await vault.collect(rootsOf)).toEqual({ unlinked: [WORLD_CID], young: [] });
  });

  it("DO-18 collection waits for a commit paused between object acceptance and event append, past grace; the event then retains the object", async () => {
    const { vault, now } = open({ graceMs: 0 });
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
    expect(await vault.stores.objects.has(HELLO_CID)).toBe(true); // accepted, unreferenced, grace 0: eligible if collection ran now
    now.advance(HOUR);
    const keeps: number[] = [];
    const collecting = vault.collect(async (held) => {
      keeps.push((await all(held.events.scan())).length);
      return rootsOf(held);
    });
    expect(await settled(collecting)).toBe(false);
    g.open();
    const events = await committing;
    expect(events.length).toBe(1);
    expect(await collecting).toEqual({ unlinked: [], young: [] });
    expect(keeps).toEqual([1]); // the keep set was computed after the commit landed
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.has(WORLD_CID)).toBe(true);
  });

  it("DO-19 the keep set is computed after the lock is acquired and held through unlink; a commit issued meanwhile starts after the pass", async () => {
    const { vault, now } = open({ graceMs: 0 });
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft()]);
    now.advance(HOUR);
    const order: string[] = [];
    const g = gate();
    const collecting = vault.collect(async (held) => {
      order.push("keep in");
      expect(vault.lock.held).toBe(true);
      const roots = await rootsOf(held);
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
    expect(await collecting).toEqual({ unlinked: [HELLO_CID], young: [] });
    // the commit ran after the pass, and found its root gone
    await expect(committing).rejects.toThrow(MissingRoot);
    expect(order).toEqual(["keep in", "keep out", "commit failed: MissingRoot"]);
  });

  it("collection validates the keep set before touching anything", async () => {
    const { vault, now } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft()]);
    now.advance(2 * HOUR);
    await expect(vault.collect(() => ["not-a-cid" as Cid])).rejects.toThrow(InvalidCid);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
  });
});

describe("the held view (event-store.md §10: nested calls share the lock)", () => {
  it("an operation under the lock can commit, open, read, write and nest without waiting for itself", async () => {
    const { vault } = open();
    const v = vault.vault;
    const result = await vault.locked(async (held) => {
      expect(vault.lock.held).toBe(true);
      const [event] = await held.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
      const bytes = await held.objects.read(HELLO_CID, 5);
      const stream = (await held.objects.open(HELLO_CID)) as ReadableStream<Uint8Array>;
      await held.files.write("under-lock.txt", WORLD);
      const nested = await held.locked(async (again) => {
        expect(again).toBe(held);
        return (await all(again.events.scan())).length;
      });
      const collected = await held.collect(rootsOf);
      return { event: event as Event, bytes, stream, nested, collected };
    });
    expectBytes(result.bytes, HELLO);
    expect(result.nested).toBe(1);
    expect(result.collected).toEqual({ unlinked: [], young: [] });
    expect(vault.lock.held).toBe(false);
    expectBytes((await drain(result.stream)).bytes, HELLO);
    expectBytes(await v.files.read("under-lock.txt"), WORLD);
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
    const writing = v.files.write("f", HELLO).then(() => order.push("write"));
    expect(await settled(committing)).toBe(false);
    g.open();
    await expect(locked).rejects.toThrow("boom");
    await committing;
    await writing;
    expect(order).toEqual(["locked in", "locked out", "commit", "write"]);
    expect(vault.lock.held).toBe(false);
  });

  it("reads through the facade take no lock: a scan, stat, has, list and file read land while an operation holds it", async () => {
    const { vault } = open();
    const v = vault.vault;
    await v.commit([{ cid: HELLO_CID, source: HELLO }], [draft([HELLO_CID])]);
    await v.files.write("f", WORLD);
    const g = gate();
    const locked = vault.locked(() => g.wait);
    await tick();
    expect((await all(v.events.scan())).length).toBe(1);
    expect(await v.objects.has(HELLO_CID)).toBe(true);
    expect(await v.objects.stat(HELLO_CID)).toMatchObject({ size: 5 });
    expect(await all(v.objects.list())).toEqual([HELLO_CID]);
    expectBytes(await v.files.read("f"), WORLD);
    expect(await v.files.list()).toEqual(["f"]);
    expect(await settled(v.objects.open(HELLO_CID))).toBe(false); // open does take it
    g.open();
    await locked;
  });
});

describe("VaultRuntime.ingest (event-store.md §5.3, §10)", () => {
  it("ingests another replica's events under the lock; its own unseen event is ForkedAuthor", async () => {
    const other = new MemoryVault({ author: authorN(2), now: clock(T0).now });
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
    expect(await ingesting).toBeDefined();
    expect(await vault.ingest([foreign])).toMatchObject({ added: 0, duplicates: 1 });
    const [own] = await vault.vault.commit([], [draft()]);
    const forked = { ...(own as Event), eventId: (foreign as Event).eventId.replace(/.$/, "f") };
    await expect(vault.ingest([forked])).rejects.toThrow(ForkedAuthor);
    expect((await all(vault.vault.events.scan())).length).toBe(2);
  });

  it("the held view ingests too, for import and restore", async () => {
    const other = new MemoryVault({ author: authorN(2) });
    const events = await other.vault.commit([], [draft(), draft()]);
    const { vault } = open();
    const outcome = await vault.locked((held) => held.ingest(events));
    expect(outcome.added).toBe(2);
  });
});
