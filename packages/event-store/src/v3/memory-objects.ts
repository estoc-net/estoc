/**
 * The version-3 object store as a map in memory: the reference for the interface's
 * semantics, and the store `objectStoreSuite` is first run against. An object is held in
 * internal extents of a chosen size — invisible at the portable layer, and how the suite
 * shows they are. Nothing persists, so the process-durable half of the store's promise
 * is vacuous here; the rest is not: a put is hashed as it streams and visible only
 * whole, the bytes handed back are rehashed on the way out, an object a read finds
 * damaged is known damaged from then on, and collection deletes exactly the unkept.
 *
 * A put verifies its bytes as they stream, into memory of its own, and lands them in
 * one synchronous step; `prepare` splits the two, so a vault commit verifies its
 * objects where no read sees them and publishes them in the same step as its events.
 * Every step that changes what is held is synchronous: two operations may verify at
 * once, and each lands only what it verified, never another's. A vault runtime still
 * holds its lock around `collect` for the commit boundary, which is its to keep, not
 * this store's. A stream open when its object is replaced or collected reads the
 * bytes it opened on to their end: complete, and verified against the CID before it
 * completes.
 */

import { compareBytes, type DaslCid } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { DamagedObject, DigestMismatch, ObjectTooLarge } from "./errors.js";
import type { Cid } from "./event.js";
import { hashSource, rawCidOf, sortCids, type ByteSource, type Collected, type ObjectInfo, type ObjectStore, type Preparation } from "./objects.js";

/** The accepted-size bound a store has when given none: 1 GiB. */
export const DEFAULT_MAX_OBJECT_BYTES = 1024 * 1024 * 1024;
/** The extent size a store in memory has when given none: 1 MiB. */
export const DEFAULT_EXTENT_BYTES = 1024 * 1024;

export interface MemoryObjectStoreOptions {
  /** the largest object a put accepts; default 1 GiB */
  maxObjectBytes?: number;
  /** the size of the internal extents an object is held in; default 1 MiB */
  extentBytes?: number;
}

/** One accepted object: its bytes in extents. */
interface Held {
  cid: DaslCid;
  extents: Uint8Array[];
  size: number;
}

export class MemoryObjectStore implements ObjectStore {
  private readonly maxObjectBytes: number;
  private readonly extentBytes: number;
  private readonly held = new Map<string, Held>();
  /** the accepted objects a read of this session found not to hash to their CID */
  private readonly damaged = new Set<string>();

  constructor(options: MemoryObjectStoreOptions = {}) {
    this.maxObjectBytes = bound("maxObjectBytes", options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
    this.extentBytes = bound("extentBytes", options.extentBytes ?? DEFAULT_EXTENT_BYTES);
    if (this.extentBytes === 0) throw new RangeError("extentBytes is at least 1");
  }

  async putRaw(source: ByteSource): Promise<ObjectInfo> {
    const packer = new Packer(this.extentBytes);
    const { cid, size } = await hashSource(source, this.maxObjectBytes, (chunk) => packer.push(chunk));
    return this.accept({ cid, extents: packer.extents(), size });
  }

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    return this.accept(await this.verify(cid, source));
  }

  /** `source` hashed into extents of this store's size, its CID checked before a byte is read; `DigestMismatch` when the bytes are not `cid`'s. */
  private async verify(cid: Cid, source: ByteSource): Promise<Held> {
    const want = rawCidOf(cid);
    const packer = new Packer(this.extentBytes);
    const got = await hashSource(source, this.maxObjectBytes, (chunk) => packer.push(chunk));
    if (got.cid.text !== want.text) throw new DigestMismatch(want.text, got.cid.text);
    return { cid: want, extents: packer.extents(), size: got.size };
  }

  /**
   * The one step that makes an object visible, synchronous and whole.
   * An object already held and sound is one object still, its bytes
   * untouched; one known damaged is replaced by the bytes verified
   * now, and the damage forgotten. A stream open on the old bytes
   * keeps reading them and, finding them damaged, fails without
   * touching the new ones.
   */
  private accept(verified: Held): ObjectInfo {
    const have = this.held.get(verified.cid.text);
    if (have !== undefined && !this.damaged.has(verified.cid.text)) return info(have.cid, have.size);
    this.held.set(verified.cid.text, verified);
    this.damaged.delete(verified.cid.text);
    return info(verified.cid, verified.size);
  }

  /**
   * A preparation over this store: what is put through it is verified
   * now and held by the preparation alone until `publish`, one
   * synchronous step that accepts each prepared object under
   * `putObject`'s rules. Dropped unpublished, it leaves the store as
   * it was. Two preparations in flight are two: each publishes only
   * what it verified.
   */
  prepare(): MemoryPreparation {
    return new MemoryPreparation(
      (cid, source) => this.verify(cid, source),
      (cid) => this.has(cid),
      (verified) => this.accept(verified)
    );
  }

  /** The object `cid` names, or null for absence; `DamagedObject` for one known damaged. Every read starts here. */
  private sound(cid: Cid): Held | null {
    rawCidOf(cid);
    if (this.damaged.has(cid)) throw new DamagedObject(cid);
    return this.held.get(cid) ?? null;
  }

  async open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    const held = this.sound(cid);
    if (held === null) return null;
    // The stream pulls nothing until read (highWaterMark 0), rehashes
    // each extent on the way out, and fails on the read after the last
    // extent when the digest is not the CID's.
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
              controller.error(new DamagedObject(cid));
              return;
            }
            controller.close();
          } catch (err) {
            controller.error(err);
          }
        },
      },
      { highWaterMark: 0 }
    );
  }

  async read(cid: Cid, maxBytes: number): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
    const held = this.sound(cid);
    if (held === null) return null;
    if (held.size > maxBytes) throw new ObjectTooLarge(`${cid} is ${held.size} bytes, more than the ${maxBytes}-byte bound`); // before allocating
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
  }

  /**
   * Do the bytes read still hash to the CID? If not, and they are still
   * what is held — not replaced since the read opened — the object is
   * known damaged from here on; either way the caller fails the read.
   */
  private verified(held: Held, digest: Uint8Array): boolean {
    if (compareBytes(digest, held.cid.digest) === 0) return true;
    if (this.held.get(held.cid.text) === held) this.damaged.add(held.cid.text);
    return false;
  }

  async stat(cid: Cid): Promise<ObjectInfo | null> {
    const held = this.sound(cid);
    return held === null ? null : info(held.cid, held.size);
  }

  async has(cid: Cid): Promise<boolean> {
    return this.sound(cid) !== null;
  }

  async *list(): AsyncIterable<Cid> {
    for (const cid of this.cids()) {
      if (this.damaged.has(cid)) throw new DamagedObject(cid);
      yield cid;
    }
  }

  /** Every accepted CID, in binary-CID byte order, as of now. */
  private cids(): Cid[] {
    return [...this.held.values()].sort((a, b) => compareBytes(a.cid.bytes, b.cid.bytes)).map((held) => held.cid.text as Cid);
  }

  async collect(keep: Iterable<Cid>): Promise<Collected> {
    const kept = new Set<string>();
    for (const cid of keep) kept.add(rawCidOf(cid).text); // every keep CID checked before anything is touched
    const removed: Cid[] = [];
    for (const cid of this.held.keys()) {
      if (kept.has(cid)) continue;
      this.held.delete(cid);
      this.damaged.delete(cid);
      removed.push(cid as Cid);
    }
    return { removed: sortCids(removed) };
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

/**
 * The objects of one commit between verification and publication:
 * verified into memory of their own, seen by no read of the store, and
 * accepted all in one synchronous step when the commit publishes.
 */
export class MemoryPreparation implements Preparation {
  private readonly prepared = new Map<string, Held>();

  constructor(
    private readonly verify: (cid: Cid, source: ByteSource) => Promise<Held>,
    private readonly stored: (cid: Cid) => Promise<boolean>,
    private readonly accept: (verified: Held) => ObjectInfo
  ) {}

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    const verified = await this.verify(cid, source);
    this.prepared.set(verified.cid.text, verified);
    return info(verified.cid, verified.size);
  }

  async has(cid: Cid): Promise<boolean> {
    rawCidOf(cid);
    return this.prepared.has(cid) || this.stored(cid);
  }

  /** Accept every prepared object, now, in one synchronous step; the preparation is empty after. */
  publish(): void {
    for (const verified of this.prepared.values()) this.accept(verified);
    this.prepared.clear();
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
