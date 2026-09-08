/**
 * The folder object store over any backend, as cases that run anywhere:
 * vitest wraps them for memory and disk, and a page in a real browser runs
 * the same list against OPFS (`../../browser/opfs-entry.ts`). No test
 * framework is imported here, and no clock is pinned — the backend's
 * modification times are the platform's, so grace is either zero or an
 * hour.
 */

import { sha256 } from "@noble/hashes/sha2";

import type { VaultBackend } from "../../../src/backend/types.js";
import { DAMAGED_DIR, DamagedObject, DigestMismatch, FolderObjectStore, STAGING_DIR, chunksOf, compareCids, objectPath, rawCidFromDigest, type Cid } from "../../../src/v3/index.js";

export type Fresh = () => Promise<VaultBackend>;

export interface ObjectCase {
  name: string;
  run: (fresh: Fresh) => Promise<void>;
}

const BASE = ".estoc";
const HOUR = 60 * 60 * 1000;
const HELLO = new TextEncoder().encode("hello");
const HELLO_CID = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq" as Cid;

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

function sameBytes(actual: Uint8Array | null | undefined, expected: Uint8Array, what: string): void {
  if (!(actual instanceof Uint8Array)) throw new Error(`${what}: expected bytes, got ${String(actual)}`);
  if (actual.length !== expected.length) throw new Error(`${what}: ${actual.length} bytes, expected ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`${what}: bytes differ at offset ${i}`);
  }
}

async function rejects(work: Promise<unknown>, error: new (...args: never[]) => Error, what: string): Promise<void> {
  try {
    await work;
  } catch (err) {
    if (err instanceof error) return;
    throw new Error(`${what}: rejected with the wrong error: ${String(err)}`);
  }
  throw new Error(`${what}: did not reject`);
}

function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = (seed >>> 0) || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

function cidOf(bytes: Uint8Array): Cid {
  return rawCidFromDigest(sha256(bytes)).text as Cid;
}

async function* chunked(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let at = 0; at < bytes.length; at += size) yield bytes.slice(at, Math.min(at + size, bytes.length));
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) throw new Error("expected a stream, got null");
  const parts: Uint8Array[] = [];
  for await (const chunk of chunksOf(stream)) parts.push(chunk);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

async function names(backend: VaultBackend, rel: string): Promise<string[]> {
  return (await backend.list(`${BASE}/${rel}`)).sort();
}

export const folderObjectCases: ObjectCase[] = [
  {
    name: "the vectors, and an object put in chunks, hold the same CID and bytes as anywhere else; the file is exactly the bytes",
    run: async (fresh) => {
      const backend = await fresh();
      const store = new FolderObjectStore(backend, { base: BASE });
      same(await store.putRaw(new Uint8Array(0)), { cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", codec: "raw", size: 0 }, "the empty object");
      same(await store.putObject(HELLO_CID, HELLO), { cid: HELLO_CID, codec: "raw", size: 5 }, "hello by putObject");
      const bytes = bytesOf(300 * 1024 + 7, 1);
      const want = cidOf(bytes);
      same(await store.putRaw(chunked(bytes, 10_007)), { cid: want, codec: "raw", size: bytes.length }, "a chunked put");
      sameBytes(await backend.read(`${BASE}/${objectPath(want)}`), bytes, "the file at objects/<cid>");
      sameBytes(await drain(await store.open(want)), bytes, "streamed back");
      sameBytes(await store.read(want, bytes.length), bytes, "read back");
      same(await store.stat(want), { cid: want, codec: "raw", size: bytes.length }, "stat");
      same(await store.has(want), true, "has");
      same(await names(backend, STAGING_DIR), [], "nothing left in staging");
      same(await backend.dirs(`${BASE}/objects`), [], "no directory under objects/");
      const listed = await all(store.list());
      same(listed, [...listed].sort(compareCids), "list in binary-CID order");
      same(listed.length, 3, "three objects");
    },
  },
  {
    name: "a mismatch under the CID given is refused with nothing exposed; a put over a held object is one object still",
    run: async (fresh) => {
      const backend = await fresh();
      const store = new FolderObjectStore(backend, { base: BASE });
      const bytes = bytesOf(5_000, 2);
      await rejects(store.putObject(cidOf(bytes), bytesOf(5_000, 3)), DigestMismatch, "a mismatch");
      same(await store.has(cidOf(bytes)), false, "not there");
      same(await names(backend, "objects"), [], "nothing under objects/");
      same(await names(backend, STAGING_DIR), [], "nothing left in staging");
      const cid = (await store.putRaw(bytes)).cid;
      same((await store.putObject(cid, bytes)).cid, cid, "again");
      same(await all(store.list()), [cid], "one object");
      sameBytes(await store.read(cid, 5_000), bytes, "its bytes");
    },
  },
  {
    name: "collection keeps the keep set and the latched, unlinks the rest past grace, and lists the young",
    run: async (fresh) => {
      const backend = await fresh();
      const store = new FolderObjectStore(backend, { base: BASE, graceMs: HOUR });
      const kept = (await store.putRaw(bytesOf(10, 4))).cid;
      const orphan = (await store.putRaw(bytesOf(10, 5))).cid;
      same(await store.collect([kept]), { unlinked: [], young: [orphan] }, "within grace");
      const now = new FolderObjectStore(backend, { base: BASE, graceMs: 0 });
      const latched = (await now.putRaw(bytesOf(10, 6))).cid;
      const stream = (await now.open(latched)) as ReadableStream<Uint8Array>;
      same(await now.collect([kept]), { unlinked: [orphan], young: [] }, "past grace: the orphan goes, the latched stays");
      same(await now.has(orphan), false, "the orphan is gone");
      same(await backend.read(`${BASE}/${objectPath(orphan)}`), null, "its file too");
      same(await now.has(latched), true, "the latched stays");
      await stream.cancel();
      same(await now.collect([kept]), { unlinked: [latched], young: [] }, "released: it goes");
      same(await all(now.list()), [kept], "the kept alone");
    },
  },
  {
    name: "a file whose bytes do not spell its name fails the stream and is moved to local/damaged/objects/",
    run: async (fresh) => {
      const backend = await fresh();
      const store = new FolderObjectStore(backend, { base: BASE });
      const bytes = bytesOf(2_000, 7);
      const cid = (await store.putRaw(bytes)).cid;
      const wrong = bytesOf(2_000, 8);
      await backend.write(`${BASE}/${objectPath(cid)}`, wrong);
      same(await store.has(cid), true, "present until looked at");
      await rejects(drain(await store.open(cid)), DamagedObject, "the stream");
      same(await store.has(cid), false, "absent after");
      same(await names(backend, "objects"), [], "nothing under objects/");
      sameBytes(await backend.read(`${BASE}/${DAMAGED_DIR}/${cid}`), wrong, "moved aside");
      await backend.write(`${BASE}/objects/not-a-cid`, HELLO);
      same((await store.damaged()).map((d) => d.where), ["objects/not-a-cid"], "reported");
      same(await all(store.list()), [], "not listed");
      same((await store.verify()).map((d) => d.where), ["objects/not-a-cid"], "verify reports it");
      same(await names(backend, DAMAGED_DIR), [cid, "not-a-cid"].sort(), "and moved it aside");
    },
  },
  {
    name: "a larger object streams in and out through the folder in pieces",
    run: async (fresh) => {
      const backend = await fresh();
      const store = new FolderObjectStore(backend, { base: BASE });
      const size = 3 * 1024 * 1024 + 1;
      const piece = 64 * 1024;
      async function* large(): AsyncIterable<Uint8Array> {
        for (let at = 0; at < size; at += piece) yield bytesOf(Math.min(piece, size - at), at + 1);
      }
      const hash = sha256.create();
      for await (const part of large()) hash.update(part);
      const want = rawCidFromDigest(hash.digest()).text as Cid;
      same(await store.putRaw(large()), { cid: want, codec: "raw", size }, "put");
      const back = sha256.create();
      let seen = 0;
      let chunks = 0;
      for await (const part of chunksOf((await store.open(want)) as ReadableStream<Uint8Array>)) {
        back.update(part);
        seen += part.length;
        chunks += 1;
      }
      same(seen, size, "every byte back");
      same(rawCidFromDigest(back.digest()).text, want, "hashing to the CID");
      same(chunks > 1, true, "in more than one piece");
    },
  },
];
