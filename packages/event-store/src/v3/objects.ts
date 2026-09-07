/**
 * The version-3 object model of `docs/replica-model/dasl-objects.md`:
 * raw DASL objects (§4), whole-resource identity however large (§5),
 * the `ObjectStore` interface (§6) and the read latch every store
 * shares with its collector (event-store.md §10). The model with no
 * store behind it: the byte-source shapes, incremental hashing to a
 * raw CID, the checks every CID argument passes, and the latch
 * registry. What an object means is nobody's business here — bytes in,
 * the same bytes out, under the one CID that names them.
 */

import { RAW_CODE, cidFromBytes, compareBytes, parseCid, type DaslCid } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { InvalidCid, ObjectTooLarge } from "./errors.js";
import type { Cid } from "./event.js";

/** Bytes as a store takes them (§6): whole, or as a stream of chunks in order. */
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** What a store knows of an accepted object without reading it: its CID, its codec — only `raw` in phase 1 — and its size in bytes. */
export type ObjectInfo = {
  cid: Cid;
  codec: "raw";
  size: number;
};

/** `unlinked`: made unavailable by this pass; `young`: unkept, but within grace, so seen again next pass (§8.3). */
export interface Collected {
  unlinked: Cid[];
  young: Cid[];
}

/**
 * The backend object interface (§6). `putRaw`, `putObject` and
 * `collect` are internal to `Vault.commit`, validated import/restore and
 * the vault runtime's collection; application code sees the rest
 * through `Vault.objects` (event-store.md §10). Every CID argument is a
 * validated canonical raw DASL CID string: a store checks each one and
 * throws `InvalidCid` before doing anything else, so a CIDv0, an
 * uppercase or padded spelling, a DRISL, dag-pb, BLAKE3 or truncated
 * identifier is refused by reader and writer alike (§3, DO-3, DO-15).
 */
export interface ObjectStore {
  /** Store exact bytes as one whole-resource raw DASL object (§6.1): hashed as they stream, visible only once complete. */
  putRaw(source: ByteSource): Promise<ObjectInfo>;
  /** Verify and atomically accept exact bytes under an expected CID (§6.2): nothing is visible until the whole stream matches; a match on an object already held is idempotent. */
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;
  /** The exact bytes of an accepted object as a stream, or `null` (§6.3); latched against collection until the stream completes, fails or is cancelled. */
  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;
  /** The whole object, or `null`; throws `ObjectTooLarge` before allocating when it is larger than `maxBytes` (§6.3). */
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;
  stat(cid: Cid): Promise<ObjectInfo | null>;
  has(cid: Cid): Promise<boolean>;
  /** Every accepted object, in binary-CID byte order, over a snapshot. */
  list(): AsyncIterable<Cid>;
  /**
   * Unlink every accepted object not in `keep` whose orphan grace has
   * elapsed and that no read latches (§8.3): the exact set, no
   * traversal; an invalid CID in `keep` fails the pass before it
   * begins. Both arrays unique, in binary-CID byte order.
   */
  collect(keep: Iterable<Cid>): Promise<Collected>;
}

// ---- CIDs ---------------------------------------------------------------

/**
 * The CID `cid` names, decoded, if it is a canonical raw DASL CID (§3);
 * otherwise `InvalidCid`. What every store method runs on each CID it
 * is handed.
 */
export function rawCidOf(cid: unknown): DaslCid {
  if (typeof cid !== "string") throw new InvalidCid("a CID is a string");
  let parsed: DaslCid;
  try {
    parsed = parseCid(cid);
  } catch (err) {
    throw new InvalidCid(`${JSON.stringify(cid)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.code !== RAW_CODE) throw new InvalidCid(`${cid} is not a raw CID (codec 0x${parsed.code.toString(16)})`);
  return parsed;
}

/** The raw DASL CID whose digest is `digest` (§4.1): `01 55 12 20` and the 32 bytes. */
export function rawCidFromDigest(digest: Uint8Array): DaslCid {
  if (digest.length !== 32) throw new InvalidCid(`a sha-256 digest is 32 bytes, not ${digest.length}`);
  const bytes = new Uint8Array(36);
  bytes.set([0x01, RAW_CODE, 0x12, 0x20]);
  bytes.set(digest, 4);
  return cidFromBytes(bytes);
}

/** Binary-CID byte order (§8.3), the order `list` and `collect` report in; not the string order, whose alphabet is not ASCII order. */
export function compareCids(a: Cid, b: Cid): number {
  return compareBytes(parseCid(a).bytes, parseCid(b).bytes);
}

/** `cids` unique and in binary-CID byte order. */
export function sortCids(cids: Iterable<Cid>): Cid[] {
  return [...new Set(cids)].sort(compareCids);
}

// ---- sources ------------------------------------------------------------

/**
 * Any `ByteSource` as one stream of chunks, so a store consumes one
 * shape (§6.1 step 1). A chunk that is not a `Uint8Array` throws where
 * it is met. Stopping early releases the source: a stream reader is
 * cancelled, an iterator returned.
 */
export async function* chunksOf(source: ByteSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (isReadableStream(source)) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield checkChunk(value);
      }
    } finally {
      reader.releaseLock();
      await source.cancel().catch(() => undefined);
    }
  }
  if (typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== "function") {
    throw new TypeError("a ByteSource is a Uint8Array, an AsyncIterable<Uint8Array> or a ReadableStream<Uint8Array>");
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield checkChunk(chunk);
}

function isReadableStream(source: unknown): source is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && source instanceof ReadableStream;
}

function checkChunk(chunk: unknown): Uint8Array {
  if (!(chunk instanceof Uint8Array)) throw new TypeError("a ByteSource yields Uint8Array chunks");
  return chunk;
}

/**
 * A source consumed and hashed as it streams (§5, §6.1 steps 1–3): the
 * chunks are handed to `sink` in order, the sha-256 runs alongside, and
 * the raw CID comes out at the end. Never more than one chunk is held
 * here. A source longer than `maxBytes` throws `ObjectTooLarge` at the
 * chunk that crosses the bound and is not read further.
 */
export async function hashSource(
  source: ByteSource,
  maxBytes: number,
  sink: (chunk: Uint8Array) => void
): Promise<{ cid: DaslCid; size: number }> {
  const hash = sha256.create();
  let size = 0;
  for await (const chunk of chunksOf(source)) {
    size += chunk.length;
    if (size > maxBytes) throw new ObjectTooLarge(`the object is larger than the ${maxBytes}-byte bound`);
    hash.update(chunk);
    sink(chunk);
  }
  return { cid: rawCidFromDigest(hash.digest()), size };
}

// ---- latches ------------------------------------------------------------

/**
 * The per-CID read latch (event-store.md §10): a count of the reads
 * active on each object, shared by every handle over one object
 * namespace and consulted by its collector, which skips a latched CID
 * without waiting. A latch is held from `open`'s presence check until
 * the stream completes, fails or is cancelled — never released by idle
 * time — and a vault runtime registers and checks it under its writer
 * lock. Local read protection only; not a retention reference.
 */
export class LatchRegistry {
  private readonly counts = new Map<Cid, number>();

  /** Hold `cid`; the returned function releases this one hold, once — calling it again does nothing. */
  acquire(cid: Cid): () => void {
    this.counts.set(cid, (this.counts.get(cid) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.counts.get(cid) ?? 1) - 1;
      if (count === 0) this.counts.delete(cid);
      else this.counts.set(cid, count);
    };
  }

  /** Is any read of `cid` active? */
  isLatched(cid: Cid): boolean {
    return this.counts.has(cid);
  }

  /** How many reads of `cid` are active. */
  count(cid: Cid): number {
    return this.counts.get(cid) ?? 0;
  }

  /** Every latched CID, in binary-CID byte order; for diagnostics. */
  latched(): Cid[] {
    return sortCids(this.counts.keys());
  }
}
