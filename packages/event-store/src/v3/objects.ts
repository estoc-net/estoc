/**
 * The version-3 object model: raw DASL objects, whole-resource identity
 * however large, and the `ObjectStore` interface. The model with no
 * store behind it: the byte-source shapes, incremental hashing to a raw
 * CID, and the checks every CID argument passes. What an object means
 * is nobody's business here — bytes in, the same bytes out, under the
 * one CID that names them.
 */

import { RAW_CODE, cidFromBytes, compareBytes, parseCid, type DaslCid } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { InvalidCid, ObjectTooLarge } from "./errors.js";
import type { Cid } from "./event.js";

/** Bytes as a store takes them: whole, or as a stream of chunks in order. */
export type ByteSource = Uint8Array | AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

/** What a store knows of an accepted object without reading it: its CID, its codec — only `raw` in phase 1 — and its size in bytes. */
export type ObjectInfo = {
  cid: Cid;
  codec: "raw";
  size: number;
};

/** The CIDs a collection pass deleted: unique, in binary-CID byte order. */
export interface Collected {
  removed: Cid[];
}

/**
 * The backend object interface. `putRaw`, `putObject` and `collect` are
 * internal to `Vault.commit`, validated import/restore and the vault
 * runtime's collection; application code sees the rest through
 * `Vault.objects`. Every CID argument is a validated canonical raw DASL
 * CID string: a store checks each one and throws `InvalidCid` before
 * doing anything else, so a CIDv0, an uppercase or padded spelling, a
 * DRISL, dag-pb, BLAKE3 or truncated identifier is refused by reader and
 * writer alike.
 */
export interface ObjectStore {
  /** Store exact bytes as one whole-resource raw DASL object: hashed as they stream, visible only once complete. */
  putRaw(source: ByteSource): Promise<ObjectInfo>;
  /**
   * Verify and atomically accept exact bytes under an expected CID:
   * nothing is visible until the whole stream matches. A match on a
   * sound object already held is idempotent, its bytes untouched; on
   * one known damaged it replaces the bytes whole and clears the
   * damage, and a mismatch leaves both as they were.
   */
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;
  /**
   * The exact bytes of an accepted object as a stream, rehashed on the
   * way out — a mismatch fails the stream before it completes — or
   * `null` for absence; `DamagedObject` for an object known damaged.
   * The bytes are complete or the stream fails: collection or a repair
   * meanwhile never makes it a truncated or mixed read.
   */
  open(cid: Cid): Promise<ReadableStream<Uint8Array> | null>;
  /** The whole object, `null` for absence, `DamagedObject` for known damage; throws `ObjectTooLarge` before allocating when it is larger than `maxBytes`. */
  read(cid: Cid, maxBytes: number): Promise<Uint8Array | null>;
  /** The metadata of an accepted object, `null` for absence, `DamagedObject` for known damage. */
  stat(cid: Cid): Promise<ObjectInfo | null>;
  /** Accepted presence; `false` for absence only, `DamagedObject` for known damage. */
  has(cid: Cid): Promise<boolean>;
  /** Every accepted object, in binary-CID byte order, over a snapshot; fails on reaching one known damaged, yielding neither it nor a list without it. */
  list(): AsyncIterable<Cid>;
  /**
   * Delete every accepted object not in `keep`: the exact set, no
   * traversal, no age; an invalid CID in `keep` fails the pass before
   * it begins. A kept object known damaged stays, its damage still
   * known; an unkept one goes like any other and is in `removed`.
   */
  collect(keep: Iterable<Cid>): Promise<Collected>;
}

/**
 * A commit's objects before they publish. Bytes put here are verified
 * against their CID and held where no read of the store sees them —
 * not `has`, not `stat`, not `list` — until the transaction they belong
 * to publishes them, new objects and repairs alike, together with its
 * events; a transaction that fails drops them and nothing of the store
 * changes. A root check in the transaction asks `has` here, which counts
 * what is prepared as present.
 */
export interface Preparation {
  /** Verify `source` against `cid` under `putObject`'s rules and hold the bytes here, unpublished. */
  putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo>;
  /** Prepared here, or accepted and sound in the store; `false` for absence, `DamagedObject` for known damage not repaired here. */
  has(cid: Cid): Promise<boolean>;
}

// ---- CIDs ---------------------------------------------------------------

/**
 * The CID `cid` names, decoded, if it is a canonical raw DASL CID;
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

/** The raw DASL CID whose digest is `digest`: `01 55 12 20` and the 32 bytes. */
export function rawCidFromDigest(digest: Uint8Array): DaslCid {
  if (digest.length !== 32) throw new InvalidCid(`a sha-256 digest is 32 bytes, not ${digest.length}`);
  const bytes = new Uint8Array(36);
  bytes.set([0x01, RAW_CODE, 0x12, 0x20]);
  bytes.set(digest, 4);
  return cidFromBytes(bytes);
}

/** Binary-CID byte order, the order `list` and `collect` report in; not the string order, whose alphabet is not ASCII order. */
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
 * shape. A chunk that is not a `Uint8Array` throws where it is met.
 * Stopping early releases the source: a stream reader is cancelled, an
 * iterator returned.
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
 * A source consumed and hashed as it streams: the chunks are handed to
 * `sink` in order, the sha-256 runs alongside, and the raw CID comes
 * out at the end. Never more than one chunk is held here. A source
 * longer than `maxBytes` throws `ObjectTooLarge` at the chunk that
 * crosses the bound and is not read further.
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
