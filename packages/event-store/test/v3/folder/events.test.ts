import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { FsBackend } from "../../../src/node.js";
import {
  BadToken,
  FolderEventStore,
  ForkedAuthor,
  MemoryBackend,
  canonicalEventBytes,
  compareEvents,
  encodeLines,
  isSegmentName,
  openReplica,
  segmentPath,
  text,
  utf8,
  type Event,
  type Replica,
  type VaultBackend,
} from "../../../src/v3/index.js";
import { eventStoreSuite, type OpenOptions } from "../suite/event-store-suite.js";
import { all, altered, authorN, clock, expectBytes, ids, reordered, uuidv7At } from "../suite/helpers.js";

const T0 = "2026-09-07T10:00:00.000Z";
const BASE = ".estoc";
/** A segment name the tests mint by hand: its embedded time is 2027, so it sorts after any the store mints today. */
const SEG = (n: number): string => uuidv7At(1_800_000_000_000 + n, 0x5e5e5e00 + n);
/** One from 2001: sorts before any the store mints. */
const EARLY = (n: number): string => uuidv7At(1_000_000_000_000 + n, 0x0e0e0e00 + n);

/** A store over `backend`, as a writable open would give it: `local/replica.json` read or minted (§11.1 step 5), the author the test names. */
async function openOver(backend: VaultBackend, options: OpenOptions & { rotateBytes?: number } = {}): Promise<FolderEventStore> {
  const replica = await openReplica(backend, BASE, options.author === undefined ? undefined : () => ({ replica_id: options.author as Replica["replica_id"], store_generation: SEG(Math.floor(Math.random() * 1e6)) }));
  return new FolderEventStore(backend, replica, {
    base: BASE,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.rotateBytes === undefined ? {} : { rotateBytes: options.rotateBytes }),
  });
}

eventStoreSuite("FolderEventStore over MemoryBackend", (options) => openOver(new MemoryBackend(), options));

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "estoc-v3-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

eventStoreSuite("FolderEventStore over FsBackend", async (options) => openOver(new FsBackend(await tempDir()), options));

/** Every segment path under `events/` of `backend`, relative to the layout, in path order. */
async function segmentsOf(backend: VaultBackend): Promise<string[]> {
  const out: string[] = [];
  for (const author of (await backend.dirs(`${BASE}/events`)).sort()) {
    for (const name of (await backend.list(`${BASE}/events/${author}`)).sort()) out.push(`events/${author}/${name}`);
  }
  return out;
}

async function bytesAt(backend: VaultBackend, rel: string): Promise<Uint8Array> {
  return (await backend.read(`${BASE}/${rel}`)) as Uint8Array;
}

describe("FolderEventStore (vault-folder.md §6, §8, §10.3, §11)", () => {
  it("VF-1, VF-7: events land under events/<replica_id>/<uuidv7>.jsonl, the author from local/replica.json, with no replica-creation event", async () => {
    const backend = new MemoryBackend();
    const store = await openOver(backend, { now: clock(T0).now });
    expect(await all(store.scan())).toEqual([]);
    const event = await store.append({ type: "t", data: {} });
    const replica = JSON.parse(text(await bytesAt(backend, "local/replica.json"))) as Replica;
    expect(store.author).toBe(replica.replica_id);
    expect(store.generation).toBe(replica.store_generation);
    expect(event.author).toBe(replica.replica_id);
    const segments = await segmentsOf(backend);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(new RegExp(`^events/${replica.replica_id}/[0-9a-f-]{36}\\.jsonl$`));
    expect(isSegmentName(segments[0]?.split("/").at(-1) as string)).toBe(true);
    expect(await all(store.scan())).toEqual([event]);
  });

  it("ES-10, VF-9: each stored line is exactly canonicalEventBytes(event) followed by one LF, and a reopen reads those bytes back as the same events", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const one = await store.append({ type: "t", data: { z: -0, a: [1, { y: 2, x: 3 }], s: "ü " } });
    c.advance(1);
    const batch = await store.appendAll([
      { type: "u", data: { n: 1 } },
      { type: "u", data: { n: 2 } },
    ]);
    const segments = await segmentsOf(backend);
    expect(segments).toHaveLength(2); // the append's segment and the batch's fresh one
    const stored = new Map<string, Uint8Array>();
    for (const rel of segments) stored.set(rel, await bytesAt(backend, rel));
    const lines = [...stored.values()].flatMap((bytes) => text(bytes).split("\n").slice(0, -1));
    expect(lines).toHaveLength(3);
    for (const event of [one, ...batch]) {
      expect(lines).toContain(text(canonicalEventBytes(event)));
    }
    for (const bytes of stored.values()) expect(bytes[bytes.length - 1]).toBe(0x0a);
    expectBytes(stored.get(segments.find((rel) => text(stored.get(rel) as Uint8Array).includes(batch[0]?.eventId as string)) as string), encodeLines(batch));
    // the same folder, a new process: what is read is what was written, byte for byte, and scans the same
    const again = await openOver(backend);
    expect(again.author).toBe(authorN(1));
    expect(again.generation).toBe(store.generation);
    expect(await all(again.scan())).toEqual([one, ...batch].sort(compareEvents));
    expect(JSON.stringify((await all(again.scan()))[0])).toBe(text(canonicalEventBytes(one)));
  });

  it("VF-2: a canonical line under another author's directory is damage — reported, never scanned — and the path never supplies the author", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const [foreign] = await other.appendAll([{ type: "t", data: {} }]);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const own = await store.append({ type: "t", data: {} });
    // the foreign event filed under this store's own directory by hand
    const misfiled = segmentPath(authorN(1), SEG(1));
    await backend.write(`${BASE}/${misfiled}`, encodeLines([foreign as Event]));
    expect(await all(store.scan())).toEqual([own]);
    expect(await all(store.scan({ author: authorN(2) }))).toEqual([]);
    const damaged = await store.damaged();
    expect(damaged).toHaveLength(1);
    expect(damaged[0]?.where).toBe(`${misfiled}:1`);
    expect(damaged[0]?.error).toBe(`author ${authorN(2)} in a segment of ${authorN(1)}`);
    expectBytes(damaged[0]?.bytes, canonicalEventBytes(foreign as Event));
    // filed under its own author's directory, the same line is an event
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(2))}`, encodeLines([foreign as Event]));
    expect(await all(store.scan())).toEqual([own, foreign as Event].sort(compareEvents));
    expect(await store.damaged()).toHaveLength(1);
  });

  it("VF-9: a merely compact, non-canonical line placed by hand is damage; the store itself never writes one", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const own = await store.append({ type: "t", data: { b: 1, a: 2 } });
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const [foreign] = await other.appendAll([{ type: "t", data: { b: 1, a: 2 } }]);
    const rel = segmentPath(authorN(2), SEG(3));
    await backend.write(`${BASE}/${rel}`, utf8(`${JSON.stringify(reordered(foreign as Event))}\n`));
    expect(await all(store.scan())).toEqual([own]);
    expect((await store.damaged()).map((d) => [d.where, d.error])).toEqual([[`${rel}:1`, "not the event's RFC 8785 canonical bytes"]]);
    // ingested instead, the same serialization is stored canonically (VF-11)
    await backend.remove(`${BASE}/${rel}`);
    expect(await store.ingest([reordered(foreign as Event)])).toMatchObject({ added: 1 });
    const [written] = (await segmentsOf(backend)).filter((p) => p.startsWith(`events/${authorN(2)}/`));
    expectBytes(await bytesAt(backend, written as string), encodeLines([foreign as Event]));
    expect(await store.damaged()).toEqual([]);
  });

  it("VF-10: a fragment a crash left is skipped and reported, and nothing is ever appended after it — the next append starts a fresh segment, so the two never fuse", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const first = await store.append({ type: "t", data: { n: 1 } });
    const [rel] = await segmentsOf(backend);
    const whole = await bytesAt(backend, rel as string);
    // the process died mid-line: half of a second event is on disk
    const fragment = utf8('{"at":"2026-09-07T10:00:00.000Z","author":"');
    const torn = new Uint8Array([...whole, ...fragment]);
    await backend.write(`${BASE}/${rel}`, torn);
    const reopened = await openOver(backend, { now: c.now });
    expect(await all(reopened.scan())).toEqual([first]);
    expect((await reopened.damaged()).map((d) => [d.where, d.error])).toEqual([[`${rel}:2`, "incomplete final fragment"]]);
    const second = await reopened.append({ type: "t", data: { n: 2 } });
    expectBytes(await bytesAt(backend, rel as string), torn); // the torn segment is left exactly as it was
    const segments = await segmentsOf(backend);
    expect(segments).toHaveLength(2);
    expectBytes(await bytesAt(backend, segments[1] as string), encodeLines([second]));
    expect(await all(reopened.scan())).toEqual([first, second]);
    // the fragment remains what it is, reportable damage (§8.1), here and on a fresh open
    for (const view of [reopened, await openOver(backend)]) {
      expect((await view.damaged()).map((d) => [d.where, d.error])).toEqual([[`${rel}:2`, "incomplete final fragment"]]);
      expect(await all(view.scan())).toEqual([first, second]);
    }
    const third = await reopened.append({ type: "t", data: { n: 3 } });
    expectBytes(await bytesAt(backend, segments[1] as string), encodeLines([second, third]));
    expect(await segmentsOf(backend)).toHaveLength(2);
  });

  it("r1-B: a fragment that happens to be a complete canonical event without its LF stays damage — a later append never terminates it into an accepted event", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const other = await openOver(new MemoryBackend(), { author: authorN(1), now: c.now });
    const [unfinished] = await other.appendAll([{ type: "t", data: { n: 0 } }]);
    // the process died between the last byte of the JSON and the LF
    const rel = segmentPath(authorN(1), EARLY(1));
    await backend.write(`${BASE}/${rel}`, canonicalEventBytes(unfinished as Event));
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    expect(await all(store.scan())).toEqual([]);
    expect((await store.damaged()).map((d) => d.error)).toEqual(["incomplete final fragment"]);
    const after = await store.append({ type: "t", data: { n: 1 } });
    expect(await all(store.scan())).toEqual([after]);
    expect((await store.damaged()).map((d) => [d.where, d.error])).toEqual([[`${rel}:1`, "incomplete final fragment"]]);
    expectBytes(await bytesAt(backend, rel), canonicalEventBytes(unfinished as Event));
    const again = await openOver(backend, { now: c.now });
    expect(await all(again.scan())).toEqual([after]);
    expect((await again.damaged()).map((d) => d.error)).toEqual(["incomplete final fragment"]);
    // the same bytes, a token: the fragment counts nothing
    const { token } = await again.changes();
    expect((JSON.parse(token) as { segments: Record<string, number> }).segments[rel]).toBe(0);
  });

  it("r1-A: an append the backend fails midway leaves a fragment the same instance never appends after — the next append lands whole in a fresh segment, and a reopen reads it", async () => {
    class Faulty extends MemoryBackend {
      failAfter: number | null = null;
      override async append(path: string, bytes: Uint8Array): Promise<void> {
        if (this.failAfter !== null) {
          const n = this.failAfter;
          this.failAfter = null;
          await super.append(path, bytes.subarray(0, n));
          throw new Error("simulated ENOSPC after a partial append");
        }
        await super.append(path, bytes);
      }
    }
    const backend = new Faulty();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const first = await store.append({ type: "first", data: {} });
    const [rel] = await segmentsOf(backend);
    const before = await bytesAt(backend, rel as string);
    backend.failAfter = 35;
    await expect(store.append({ type: "failed", data: {} })).rejects.toThrow("simulated ENOSPC");
    const torn = await bytesAt(backend, rel as string);
    expect(torn.length).toBe(before.length + 35);
    const succeeded = await store.append({ type: "succeeded", data: {} });
    expectBytes(await bytesAt(backend, rel as string), torn); // untouched
    const segments = await segmentsOf(backend);
    expect(segments).toHaveLength(2);
    expectBytes(await bytesAt(backend, segments[1] as string), encodeLines([succeeded]));
    for (const view of [store, await openOver(backend, { now: c.now })]) {
      expect((await all(view.scan())).map((e) => e.type)).toEqual(["first", "succeeded"]);
      expect((await view.damaged()).map((d) => [d.where, d.error])).toEqual([[`${rel}:2`, "incomplete final fragment"]]);
    }
    expect(first.type).toBe("first");
    // a failure that wrote nothing leaves the segment clean, and the next append stays in it
    backend.failAfter = 0;
    await expect(store.append({ type: "failed", data: {} })).rejects.toThrow("simulated ENOSPC");
    const next = await store.append({ type: "next", data: {} });
    expect(await segmentsOf(backend)).toHaveLength(2);
    expectBytes(await bytesAt(backend, segments[1] as string), encodeLines([succeeded, next]));
  });

  it("VF-11: ingest writes decoded, reserialized events into one fresh segment per author minted here, never a copied source segment", async () => {
    const source = new MemoryBackend();
    const c = clock(T0);
    const a = await openOver(source, { author: authorN(2), now: c.now });
    await a.append({ type: "t", data: { n: 1 } });
    await a.appendAll([{ type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }]);
    const sourceSegments = await segmentsOf(source);
    expect(sourceSegments).toHaveLength(2);
    const b = await openOver(new MemoryBackend(), { author: authorN(3), now: c.now });
    const [three] = await b.appendAll([{ type: "t", data: {} }]);
    const target = new MemoryBackend();
    const store = await openOver(target, { author: authorN(1), now: c.now });
    const incoming = [...(await all(a.scan())), three as Event];
    // through another serialization, as a snapshot or a wire would carry them
    expect(await store.ingest(incoming.map((event) => reordered(event)))).toEqual({ added: 4, duplicates: 0, conflicts: [], rejected: [] });
    const written = await segmentsOf(target);
    expect(written).toHaveLength(2); // one per incoming author, none for the store's own
    expect(written.map((p) => p.split("/")[1])).toEqual([authorN(2), authorN(3)]);
    for (const rel of written) expect(sourceSegments).not.toContain(rel);
    expectBytes(await bytesAt(target, written[0] as string), encodeLines(await all(a.scan())));
    expectBytes(await bytesAt(target, written[1] as string), encodeLines([three as Event]));
    expect(await all(store.scan())).toEqual(incoming.sort(compareEvents));
    // again: nothing written
    expect(await store.ingest(incoming)).toMatchObject({ added: 0, duplicates: 4 });
    expect(await segmentsOf(target)).toEqual(written);
  });

  it("ES-7: a fork writes nothing — not even the other authors' events of the same call", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    await store.append({ type: "t", data: {} });
    const twin = await openOver(new MemoryBackend(), { author: authorN(1), now: c.now });
    const [forkedEvent] = await twin.appendAll([{ type: "t", data: {} }]);
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const [foreign] = await other.appendAll([{ type: "t", data: {} }]);
    const before = await segmentsOf(backend);
    await expect(store.ingest([foreign, forkedEvent])).rejects.toBeInstanceOf(ForkedAuthor);
    expect(await segmentsOf(backend)).toEqual(before);
  });

  it("VF-12, §8.3: physical order — segment names, which segment a line is in, line order within one — changes nothing scan yields", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const events: Event[] = [];
    for (const n of [3, 1, 2]) {
      c.set(`2026-09-07T1${n}:00:00.000Z`);
      events.push(await store.append({ type: "t", data: { n } }));
    }
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    c.set("2026-09-07T10:30:00.000Z");
    events.push(...(await other.appendAll([{ type: "t", data: { n: 4 } }, { type: "t", data: { n: 5 } }])));
    await store.ingest(events.slice(3));
    const expected = [...events].sort(compareEvents);
    expect(await all(store.scan())).toEqual(expected);
    // the same lines rearranged by hand: every line in one segment, in reverse, under a name that sorts first
    for (const rel of await segmentsOf(backend)) await backend.remove(`${BASE}/${rel}`);
    const mine = events.filter((e) => e.author === authorN(1)).reverse();
    const theirs = events.filter((e) => e.author === authorN(2)).reverse();
    await backend.write(`${BASE}/${segmentPath(authorN(1), SEG(0))}`, encodeLines(mine));
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(9))}`, encodeLines([theirs[0] as Event]));
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(1))}`, encodeLines([theirs[1] as Event]));
    expect(await all(store.scan())).toEqual(expected);
    expect(await all((await openOver(backend)).scan())).toEqual(expected);
    expect(await store.damaged()).toEqual([]);
    expect(await store.conflicting()).toEqual([]);
  });

  it("r1 question: one eventId under two author directories — the accepted content is chosen over every segment, and a filter only narrows it: scan({author}) and changes({author}) never expose the rejected content", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(3), now: c.now });
    const a = await openOver(new MemoryBackend(), { author: authorN(1), now: c.now });
    const [asA] = await a.appendAll([{ type: "t", data: { by: "a" } }]);
    const asB = { ...(asA as Event), author: authorN(2), data: { by: "b" } } as Event; // the same ID, valid under B's directory
    await backend.write(`${BASE}/${segmentPath(authorN(1), SEG(1))}`, encodeLines([asA as Event]));
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(2))}`, encodeLines([asB]));
    expect(await all(store.scan())).toEqual([asA]);
    expect(await all(store.scan({ author: authorN(1) }))).toEqual([asA]);
    expect(await all(store.scan({ author: authorN(2) }))).toEqual([]);
    expect(await all(store.scan({ data: { by: "b" } }))).toEqual([]);
    expect(await all((await store.changes({ author: authorN(2) })).events)).toEqual([]);
    expect(await all((await store.changes({ author: authorN(1) })).events)).toEqual([asA]);
    expect(await store.conflicting()).toEqual([{ eventId: asA?.eventId, kept: asA, rejected: asB, source: `${segmentPath(authorN(2), SEG(2))}:1` }]);
  });

  it("§11.5: two contents under one eventId keep the lexicographically first segment path, then the first line, and report every other", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const [event] = await other.appendAll([{ type: "t", data: { v: "a" } }]);
    const variant = altered(event as Event);
    const later = segmentPath(authorN(2), SEG(5));
    const earlier = segmentPath(authorN(2), SEG(2));
    await backend.write(`${BASE}/${later}`, encodeLines([event as Event]));
    await backend.write(`${BASE}/${earlier}`, encodeLines([variant, event as Event]));
    expect(await all(store.scan())).toEqual([variant]); // the earlier path wins, whatever arrived first
    const conflicts = await store.conflicting();
    expect(conflicts).toEqual([
      { eventId: event?.eventId, kept: variant, rejected: event, source: `${earlier}:2` },
      { eventId: event?.eventId, kept: variant, rejected: event, source: `${later}:1` },
    ]);
    // a duplicate of identical content is not a conflict
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(7))}`, encodeLines([variant]));
    expect(await store.conflicting()).toHaveLength(2);
    // an ingest of what the store already rejects reports the kept content, as the memory store does
    expect(await store.ingest([event])).toMatchObject({ added: 0, duplicates: 0, conflicts: [{ eventId: event?.eventId, kept: variant, rejected: event }] });
    expect(await store.ingest([variant])).toMatchObject({ duplicates: 1 });
  });

  it("VF-16: an unknown entry inside events/ is reported as damage, by path, and the events beside it are still read", async () => {
    const backend = new MemoryBackend();
    const store = await openOver(backend, { author: authorN(1), now: clock(T0).now });
    const own = await store.append({ type: "t", data: {} });
    await backend.write(`${BASE}/events/README.txt`, utf8("hello"));
    await backend.write(`${BASE}/events/not-an-author/${SEG(1)}.jsonl`, encodeLines([own]));
    await backend.write(`${BASE}/events/${authorN(1)}/notes.txt`, utf8("x"));
    await backend.write(`${BASE}/events/${authorN(1)}/${SEG(2)}.jsonl.tmp`, utf8("x"));
    await backend.write(`${BASE}/events/${authorN(1)}/sub/${SEG(3)}.jsonl`, encodeLines([own]));
    await backend.write(`${BASE}/events/${authorN(1).toUpperCase()}/${SEG(4)}.jsonl`, encodeLines([own]));
    expect(await all(store.scan())).toEqual([own]);
    expect((await store.damaged()).map((d) => d.where).sort()).toEqual(
      [
        "events/README.txt",
        "events/not-an-author",
        `events/${authorN(1)}/notes.txt`,
        `events/${authorN(1)}/${SEG(2)}.jsonl.tmp`,
        `events/${authorN(1)}/sub`,
        `events/${authorN(1).toUpperCase()}`,
      ].sort()
    );
    for (const d of await store.damaged()) expect(d.error).toBeTypeOf("string");
    // objects/, local/ and opaque files are not this store's to judge
    await backend.write(`${BASE}/objects/not-a-cid`, utf8("x"));
    await backend.write(`${BASE}/notes.md`, utf8("x"));
    expect(await store.damaged()).toHaveLength(6);
  });

  it("§8.1: append reuses the newest segment under its author, rotates past rotateBytes, and appendAll always writes a fresh segment whole", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now, rotateBytes: 400 });
    const a = await store.append({ type: "t", data: { n: 1 } });
    const b = await store.append({ type: "t", data: { n: 2 } });
    expect(await segmentsOf(backend)).toHaveLength(1); // ~150 bytes each: still under 400 after one
    const cEvent = await store.append({ type: "t", data: { n: 3 } });
    const d = await store.append({ type: "t", data: { n: 4 } });
    const two = await segmentsOf(backend);
    expect(two).toHaveLength(2);
    expectBytes(await bytesAt(backend, two[0] as string), encodeLines([a, b, cEvent]));
    expectBytes(await bytesAt(backend, two[1] as string), encodeLines([d]));
    const batch = await store.appendAll([{ type: "t", data: { n: 5 } }]);
    const three = await segmentsOf(backend);
    expect(three).toHaveLength(3);
    expectBytes(await bytesAt(backend, three[2] as string), encodeLines(batch));
    // the batch's segment is the newest, so the next append goes there
    const e = await store.append({ type: "t", data: { n: 6 } });
    expectBytes(await bytesAt(backend, three[2] as string), encodeLines([...batch, e]));
    expect(await segmentsOf(backend)).toHaveLength(3);
    // a new instance over the same folder appends to the newest segment too
    const again = await openOver(backend, { now: c.now });
    const f = await again.append({ type: "t", data: { n: 7 } });
    expectBytes(await bytesAt(backend, three[2] as string), encodeLines([...batch, e, f]));
    expect(ids(await all(again.scan()))).toEqual(ids([a, b, cEvent, d, ...batch, e, f].sort(compareEvents)));
  });

  it("§10.3: a token names the generation and each segment's accepted length; it is refused for another generation, a missing or shorter segment, a position inside a line, or an unrecognized shape", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const a = await store.append({ type: "t", data: { n: 1 } });
    const { token } = await store.changes();
    const [rel] = await segmentsOf(backend);
    const length = (await bytesAt(backend, rel as string)).length;
    const parsed = JSON.parse(token) as { generation: string; segments: Record<string, number> };
    expect(parsed).toEqual({ generation: store.generation, segments: { [rel as string]: length } });
    const forge = (patch: Partial<typeof parsed>): string => JSON.stringify({ ...parsed, ...patch });
    // a later append is the delta, and only it
    const b = await store.append({ type: "t", data: { n: 2 } });
    expect(await all((await store.changes(undefined, token)).events)).toEqual([b]);
    expect(await all((await store.changes(undefined, forge({ segments: {} }))).events)).toEqual([a, b]);
    // refusals
    await expect(store.changes(undefined, forge({ generation: SEG(1) }))).rejects.toBeInstanceOf(BadToken);
    await expect(store.changes(undefined, forge({ segments: { [segmentPath(authorN(1), SEG(2))]: 0 } }))).rejects.toThrow("does not hold");
    await expect(store.changes(undefined, forge({ segments: { [rel as string]: length + 1 } }))).rejects.toThrow("inside a line");
    await expect(store.changes(undefined, forge({ segments: { [rel as string]: length - 1 } }))).rejects.toThrow("inside a line");
    await expect(store.changes(undefined, forge({ segments: { [rel as string]: length * 3 } }))).rejects.toThrow("past");
    await expect(store.changes(undefined, forge({ segments: { "events/x": 0 } }))).rejects.toThrow("not a segment path");
    await expect(store.changes(undefined, forge({ segments: { "local/replica.json": 0 } }))).rejects.toThrow("not a segment path");
    for (const bad of [-1, 1.5, "0", null, true]) {
      await expect(store.changes(undefined, forge({ segments: { [rel as string]: bad as number } })), String(bad)).rejects.toBeInstanceOf(BadToken);
    }
    for (const junk of ["", "x", "[]", "null", "1", '{"generation":1}', JSON.stringify({ generation: store.generation }), JSON.stringify({ generation: store.generation, segments: [] })]) {
      await expect(store.changes(undefined, junk), junk).rejects.toBeInstanceOf(BadToken);
    }
    // the segment truncated by hand below the position: refused
    const second = (await store.changes()).token;
    await backend.write(`${BASE}/${rel}`, encodeLines([a]));
    await expect(store.changes(undefined, second)).rejects.toThrow("past");
  });

  it("§10.3: a token survives a reopen of the same generation, and a fragment is not part of the accepted length", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const a = await store.append({ type: "t", data: { n: 1 } });
    const { token } = await store.changes();
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const foreign = await other.appendAll([{ type: "t", data: {} }, { type: "u", data: {} }]);
    const again = await openOver(backend, { now: c.now }); // the same local/replica.json: the same generation
    expect(again.generation).toBe(store.generation);
    await again.ingest(foreign);
    const b = await again.append({ type: "t", data: { n: 2 } });
    const delta = await again.changes(undefined, token);
    expect(ids(await all(delta.events)).sort()).toEqual(ids([...foreign, b]).sort());
    expect(await all((await again.changes({ type: "u" }, token)).events)).toEqual([foreign[1]]);
    expect(await all((await again.changes(undefined, delta.token)).events)).toEqual([]);
    // a crash leaves a fragment: the token stops at the last complete line, and the fragment counts nothing
    const [rel] = (await segmentsOf(backend)).filter((p) => p.includes(authorN(1)));
    const whole = await bytesAt(backend, rel as string);
    await backend.write(`${BASE}/${rel}`, new Uint8Array([...whole, ...utf8('{"at":"20')]));
    const cut = await again.changes(undefined, delta.token);
    expect(await all(cut.events)).toEqual([]);
    expect((JSON.parse(cut.token) as { segments: Record<string, number> }).segments[rel as string]).toBe(whole.length);
    // deleting local/ makes the next open another generation: every earlier token is refused (§3.1)
    await backend.remove(`${BASE}/local/replica.json`);
    const fresh = await openOver(backend, { now: c.now });
    expect(fresh.generation).not.toBe(store.generation);
    expect(fresh.author).not.toBe(store.author);
    await expect(fresh.changes(undefined, delta.token)).rejects.toBeInstanceOf(BadToken);
    expect(ids(await all(fresh.scan())).sort()).toEqual(ids([a, b, ...foreign]).sort()); // the history is all still there, under its authors (VF-23)
  });

  it("changes(): a line copied in by hand under an ID already held is no gain; what is yielded is the content the store holds", async () => {
    const backend = new MemoryBackend();
    const c = clock(T0);
    const store = await openOver(backend, { author: authorN(1), now: c.now });
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const [event] = await other.appendAll([{ type: "t", data: {} }]);
    await store.ingest([event]);
    const { token } = await store.changes();
    await backend.write(`${BASE}/${segmentPath(authorN(2), SEG(8))}`, encodeLines([event as Event]));
    expect(await all((await store.changes(undefined, token)).events)).toEqual([]);
    // a conflicting copy that wins the tie-break changes the held content but is no new event either
    await backend.write(`${BASE}/${segmentPath(authorN(2), EARLY(0))}`, encodeLines([altered(event as Event)]));
    expect(await all((await store.changes(undefined, token)).events)).toEqual([]);
    expect(await all(store.scan())).toEqual([altered(event as Event)]);
    expect(await store.conflicting()).toHaveLength(2);
  });

  it("ES-1, VF-32: what a resolved append or batch wrote survives the process — a new store over the same disk folder observes it whole", async () => {
    const dir = await tempDir();
    const c = clock(T0);
    const store = await openOver(new FsBackend(dir), { author: authorN(1), now: c.now });
    const a = await store.append({ type: "t", data: { n: 1 } });
    const batch = await store.appendAll([{ type: "t", data: { n: 2 } }, { type: "t", data: { n: 3 } }]);
    const other = await openOver(new MemoryBackend(), { author: authorN(2), now: c.now });
    const foreign = await other.appendAll([{ type: "t", data: {} }]);
    await store.ingest(foreign);
    const reopened = await openOver(new FsBackend(dir), { now: c.now });
    expect(reopened.author).toBe(authorN(1));
    expect(reopened.generation).toBe(store.generation);
    expect(await all(reopened.scan())).toEqual([a, ...batch, ...foreign].sort(compareEvents));
    expect(await reopened.damaged()).toEqual([]);
    const b = await reopened.append({ type: "t", data: { n: 4 } });
    expect(await all((await openOver(new FsBackend(dir))).scan())).toEqual([a, ...batch, ...foreign, b].sort(compareEvents));
  });

  it("hands out frozen events, from append, scan, changes and a conflict report alike", async () => {
    const store = await openOver(new MemoryBackend(), { author: authorN(1), now: clock(T0).now });
    const event = await store.append({ type: "t", data: { list: [1], nested: { a: 1 } } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data["nested"])).toBe(true);
    const [scanned] = await all(store.scan());
    expect(Object.isFrozen(scanned)).toBe(true);
    expect(Object.isFrozen(scanned?.data["list"])).toBe(true);
    const [changed] = await all((await store.changes()).events);
    expect(Object.isFrozen(changed)).toBe(true);
  });
});
