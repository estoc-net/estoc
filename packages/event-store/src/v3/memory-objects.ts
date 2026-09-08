/**
 * The version-3 object store as a map in memory: the reference for the interface's
 * semantics, and the store `objectStoreSuite` is first run against. An object is held in
 * internal extents of a chosen size — invisible at the portable layer, and how the suite
 * shows they are. Nothing persists, so the process-durable half of the store's promise
 * is vacuous here; the rest is not: a put is hashed as it streams and visible only
 * whole, a read latches its CID against collection until the stream completes, fails or
 * is cancelled, the bytes handed back are rehashed on the way out, and collection
 * unlinks exactly the unkept, unlatched objects whose grace has elapsed.
 *
 * In memory the presence check and latch registration of `open`, and the latch check and
 * unlink of `collect`, are each one synchronous step, so the serialization the vault
 * asks of the writer lock holds by construction; a vault runtime still holds its lock
 * around `collect` for the commit boundary, which is its to keep, not this store's.
 */

import { compareBytes, type DaslCid } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { DamagedObject, DigestMismatch, ObjectTooLarge } from "./errors.js";
import type { Cid } from "./event.js";
import { LatchRegistry, hashSource, rawCidOf, sortCids, type ByteSource, type Collected, type ObjectInfo, type ObjectStore } from "./objects.js";

/**
 * How old an unkept object must be before `collect` takes it: generous,
 * because the commit it may belong to is bounded by a process, not a
 * clock.
 */
export const DEFAULT_GRACE_MS = 60 * 60 * 1000;
/** The accepted-size bound a store has when given none: 1 GiB. */
export const DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
/** The extent size a store in memory has when given none: 1 MiB. */
export const DEFAULT_EXTENT_BYTES = 1024 * 1024;

export interface MemoryObjectStoreOptions {
  /** the wall clock in Unix milliseconds, for orphan age; default `Date.now`, pinned by tests */
  now?: () => number;
  /** orphan grace; default one hour */
  graceMs?: number;
  /** the largest object a put accepts; default 1 GiB */
  maxObjectBytes?: number;
  /** the size of the internal extents an object is held in; default 1 MiB */
  extentBytes?: number;
  /** the latch registry to share with other handles over the same objects; a fresh one when left out */
  latches?: LatchRegistry;
}

/** One accepted object: its bytes in extents, and when it was last accepted, for grace. */
interface Held {
  cid: DaslCid;
  extents: Uint8Array[];
  size: number;
  acceptedAt: number;
}

export class MemoryObjectStore implements ObjectStore {
  /** the read latches over this store's objects, shared or its own */
  readonly latches: LatchRegistry;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxObjectBytes: number;
  private readonly extentBytes: number;
  /** every accepted object, by CID text */
  private readonly held = new Map<string, Held>();

  constructor(options: MemoryObjectStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.graceMs = bound("graceMs", options.graceMs ?? DEFAULT_GRACE_MS);
    this.maxObjectBytes = bound("maxObjectBytes", options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
    this.extentBytes = bound("extentBytes", options.extentBytes ?? DEFAULT_EXTENT_BYTES);
    if (this.extentBytes === 0) throw new RangeError("extentBytes is at least 1");
    this.latches = options.latches ?? new LatchRegistry();
  }

  async putRaw(source: ByteSource): Promise<ObjectInfo> {
    const packer = new Packer(this.extentBytes);
    const { cid, size } = await hashSource(source, this.maxObjectBytes, (chunk) => packer.push(chunk));
    return this.accept(cid, packer.extents(), size);
  }

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    const want = rawCidOf(cid); // the CID checked before a byte is read
    const packer = new Packer(this.extentBytes);
    const got = await hashSource(source, this.maxObjectBytes, (chunk) => packer.push(chunk));
    if (got.cid.text !== want.text) throw new DigestMismatch(want.text, got.cid.text); // nothing accepted
    return this.accept(want, packer.extents(), got.size);
  }

  /**
   * The one step that makes an object visible, synchronous and whole. The
   * bytes verified this time are the ones held from here on: an object
   * already held is one object still, with its orphan age renewed — and
   * if what was held had gone bad underneath, it is now sound again. A
   * stream open on the old bytes keeps reading them; should it find them
   * damaged, `verified` sees they are no longer what is held and leaves
   * the new ones alone.
   */
  private accept(cid: DaslCid, extents: Uint8Array[], size: number): ObjectInfo {
    this.held.set(cid.text, { cid, extents, size, acceptedAt: this.now() });
    return info(cid, size);
  }

  async open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    rawCidOf(cid);
    const held = this.held.get(cid);
    if (held === undefined) return null;
    // Presence checked and latch registered in one step; the stream pulls
    // nothing until read (highWaterMark 0), rehashes each extent on the
    // way out, and releases the latch when it completes, fails or is
    // cancelled.
    // The latch is this method's from here until the stream ends, and
    // every way it can end releases it: completion, damage, cancel, and
    // any failure — building the stream, copying a chunk — which
    // releases before the stream fails, since an errored stream runs no
    // `cancel` and a caller can release nothing on its behalf.
    const release = this.latches.acquire(cid);
    try {
      const hash = sha256.create();
      let next = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            try {
              const extent = held.extents[next];
              if (extent !== undefined) {
                next += 1;
                hash.update(extent);
                controller.enqueue(new Uint8Array(extent)); // a copy: the store's bytes stay its own
                return;
              }
              if (!this.verified(held, hash.digest())) {
                release();
                controller.error(new DamagedObject(cid));
                return;
              }
              release();
              controller.close();
            } catch (err) {
              release();
              controller.error(err);
            }
          },
          cancel: () => {
            release();
          },
        },
        { highWaterMark: 0 }
      );
    } catch (err) {
      release();
      throw err;
    }
  }

  async read(cid: Cid, maxBytes: number): Promise<Uint8Array | null> {
    rawCidOf(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
    const held = this.held.get(cid);
    if (held === undefined) return null;
    if (held.size > maxBytes) throw new ObjectTooLarge(`${cid} is ${held.size} bytes, more than the ${maxBytes}-byte bound`); // before allocating
    const release = this.latches.acquire(cid);
    try {
      const out = new Uint8Array(held.size);
      const hash = sha256.create();
      let at = 0;
      for (const extent of held.extents) {
        hash.update(extent);
        out.set(extent, at);
        at += extent.length;
      }
      if (!this.verified(held, hash.digest())) throw new DamagedObject(cid);
      return out;
    } finally {
      release();
    }
  }

  /** Do the bytes read still hash to the CID? If not, the object leaves the accepted namespace, and the caller fails the read. */
  private verified(held: Held, digest: Uint8Array): boolean {
    if (compareBytes(digest, held.cid.digest) === 0) return true;
    if (this.held.get(held.cid.text) === held) this.held.delete(held.cid.text);
    return false;
  }

  async stat(cid: Cid): Promise<ObjectInfo | null> {
    rawCidOf(cid);
    const held = this.held.get(cid);
    return held === undefined ? null : info(held.cid, held.size);
  }

  async has(cid: Cid): Promise<boolean> {
    rawCidOf(cid);
    return this.held.has(cid);
  }

  async *list(): AsyncIterable<Cid> {
    for (const cid of this.cids()) yield cid;
  }

  /** Every accepted CID, in binary-CID byte order, as of now. */
  private cids(): Cid[] {
    return [...this.held.values()].sort((a, b) => compareBytes(a.cid.bytes, b.cid.bytes)).map((held) => held.cid.text as Cid);
  }

  async collect(keep: Iterable<Cid>): Promise<Collected> {
    // Every keep CID checked before anything is touched; then one
    // synchronous pass: kept and latched objects are left alone and
    // unlisted, unkept objects within grace are `young`, the rest go.
    const kept = new Set<string>();
    for (const cid of keep) kept.add(rawCidOf(cid).text);
    const now = this.now();
    const unlinked: Cid[] = [];
    const young: Cid[] = [];
    for (const held of this.held.values()) {
      const cid = held.cid.text as Cid;
      if (kept.has(cid) || this.latches.isLatched(cid)) continue;
      if (now - held.acceptedAt < this.graceMs) {
        young.push(cid);
        continue;
      }
      this.held.delete(cid);
      unlinked.push(cid);
    }
    return { unlinked: sortCids(unlinked), young: sortCids(young) };
  }

  /**
   * Fault injection for tests: flip one byte of an accepted object's held
   * bytes in place, as a bad sector would, leaving it in the accepted
   * namespace for the next read to find. Throws on an object not held, or
   * one with no bytes to damage.
   */
  damage(cid: Cid): void {
    rawCidOf(cid);
    const held = this.held.get(cid);
    if (held === undefined) throw new Error(`${cid} is not held`);
    const extent = held.extents.find((e) => e.length > 0);
    if (extent === undefined) throw new Error(`${cid} has no bytes to damage`);
    extent[0] = (extent[0] as number) ^ 0x01;
  }
}

function info(cid: DaslCid, size: number): ObjectInfo {
  return { cid: cid.text as Cid, codec: "raw", size };
}

function bound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} is a non-negative integer`);
  return value;
}

/**
 * Chunks of any size into extents of one size: each incoming chunk is
 * copied — the caller may reuse its buffer — into the extent being
 * filled, sealed when full; the last extent is whatever remains. No
 * more than one extent's worth of bytes is unsealed at a time, and
 * nothing is allocated ahead of the bytes that arrive. The copy is `new
 * Uint8Array(view)`, never `slice()`: a `Buffer` is a `Uint8Array`
 * whose `slice` is a view, and what the store holds must be memory of
 * its own, or the source could rewrite an accepted object.
 */
class Packer {
  private readonly sealed: Uint8Array[] = [];
  private parts: Uint8Array[] = [];
  private filled = 0;

  constructor(private readonly extentBytes: number) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(this.extentBytes - this.filled, chunk.length - at);
      this.parts.push(new Uint8Array(chunk.subarray(at, at + take)));
      this.filled += take;
      at += take;
      if (this.filled === this.extentBytes) this.seal();
    }
  }

  private seal(): void {
    this.sealed.push(concat(this.parts, this.filled));
    this.parts = [];
    this.filled = 0;
  }

  /** The extents so far; none for an empty object. */
  extents(): Uint8Array[] {
    return this.filled === 0 ? this.sealed : [...this.sealed, concat(this.parts, this.filled)];
  }
}

function concat(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
