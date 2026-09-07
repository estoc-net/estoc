/**
 * The version-3 object store over a folder (dasl-objects.md §10,
 * vault-folder.md §9): one file per accepted object, `objects/<cid>`,
 * flat, holding the exact resource bytes and nothing else — no extent
 * directory, no chunk, no metadata node (VF-27, VF-28). A put streams
 * its source into a private staging file under `local/`, hashing as it
 * goes and never holding more than one chunk (§5), and only once the
 * whole stream has matched — the CID given, or the one computed — is
 * the file moved into `objects/` in one step (§6.1, §6.2, VF-31): a
 * crash midway leaves a staging file, which is not an object and is
 * swept once its grace has elapsed; a source that fails leaves nothing.
 * A read streams the file back, rehashing on the way out; a file whose
 * bytes no longer spell its name fails the stream before completion,
 * is moved aside to `local/damaged/objects/`, and reads as absent from
 * then on (§6.3, §8.2, DO-13, DO-16, VF-13) — moved aside only if its
 * bytes, read again in the store's turn, still do not spell its name,
 * so a put that has healed it meanwhile stands (r1-C). An object's
 * orphan age counts from its acceptance, which the store records as
 * the modification time of a stamp file, `local/accepted/objects/<cid>`,
 * written in the same turn as the move into `objects/` and rewritten
 * by repeating acceptance (§9): not the object file's own time, which
 * a backend sets when the last chunk was written, however long the
 * source then took to end or the store's turn to come (r1-D). An
 * object with no stamp — `local/` deleted — is stamped by the first
 * collection pass that sees it and counted young. `collect` unlinks
 * exactly the unkept, unlatched objects past grace, with their stamps
 * (§8.3). What is in `objects/` and
 * not an object path — a name that is not a raw DASL CID, a directory —
 * is reported as damage, listed as nothing, and left alone by
 * collection; `verify` reads every object and moves the mismatched
 * aside (§3, VF-16).
 *
 * The store's operations run one at a time — the presence check and
 * latch registration of `open`, the latch check and unlink of `collect`
 * — as event-store.md §10 asks; the streaming of a put and the draining
 * of a read run outside that turn, so a slow source or consumer holds
 * nothing but its own bytes. A vault runtime still holds its writer lock
 * around `collect` and each commit (DO-18, DO-19), which is its to keep.
 * Durability is the backend's: an accepted object is process-durable
 * with every backend shipped (VF-32); power-loss survival is the
 * platform's flush policy.
 */

import { compareBytes, type DaslCid } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";
import { v7 } from "uuid";

import type { VaultBackend } from "../../backend/types.js";
import { DamagedLayout, DamagedObject, DigestMismatch, ObjectTooLarge } from "../errors.js";
import { isRawCid, type Cid, type Damaged } from "../event.js";
import { comparePaths } from "../files.js";
import { DEFAULT_GRACE_MS, DEFAULT_MAX_OBJECT_BYTES } from "../memory-objects.js";
import {
  LatchRegistry,
  chunksOf,
  compareCids,
  rawCidFromDigest,
  rawCidOf,
  sortCids,
  type ByteSource,
  type Collected,
  type ObjectInfo,
  type ObjectStore,
} from "../objects.js";
import { ESTOC_DIR, LOCAL_DIR, OBJECTS_DIR, objectPath } from "./layout.js";

/** Where a put streams before its bytes have a name (§6.1): private to this copy, never an object, never portable. */
export const STAGING_DIR = `${LOCAL_DIR}/staging/objects`;
/** Where damaged material is moved out of `objects/` (§9): under the same name, a numbered suffix when that is taken. */
export const DAMAGED_DIR = `${LOCAL_DIR}/damaged/objects`;
/** Where an object's acceptance is recorded (§8.3, r1-D): an empty file per CID whose modification time is when the object was last accepted. */
export const ACCEPTED_DIR = `${LOCAL_DIR}/accepted/objects`;

export interface FolderObjectStoreOptions {
  /** the layout's directory, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the wall clock in Unix milliseconds, against which a stamp's modification time is aged; default `Date.now`, pinned by tests together with the backend's clock */
  now?: () => number;
  /** orphan grace (§8.3); default one hour */
  graceMs?: number;
  /** the largest object a put accepts (§12); default 1 GiB */
  maxObjectBytes?: number;
  /** the latch registry to share with other handles over the same objects; a fresh one when left out */
  latches?: LatchRegistry;
}

/** What a file where `objects/` belongs is reported as, by a read (§3, VF-16) and by the write it refuses. */
const OBJECTS_IS_A_FILE = "a file where the objects directory belongs";

/** What one look at `objects/` found: the object files by CID, and every entry that is not one. */
interface Walked {
  cids: Cid[];
  damaged: Damaged[];
}

export class FolderObjectStore implements ObjectStore {
  /** the read latches over this store's objects (event-store.md §10), shared or its own */
  readonly latches: LatchRegistry;
  private readonly base: string;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxObjectBytes: number;
  /** the staging files puts are streaming into right now, which no sweep touches */
  private readonly staging = new Set<string>();
  /** operations run one at a time: the writer lock of event-store.md §10, as far as one store needs it */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly backend: VaultBackend,
    options: FolderObjectStoreOptions = {}
  ) {
    this.base = options.base ?? ESTOC_DIR;
    this.now = options.now ?? Date.now;
    this.graceMs = bound("graceMs", options.graceMs ?? DEFAULT_GRACE_MS);
    this.maxObjectBytes = bound("maxObjectBytes", options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
    this.latches = options.latches ?? new LatchRegistry();
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** A layout path as the backend names it. */
  private at(rel: string): string {
    return `${this.base}/${rel}`;
  }

  /** Whether a file stands where `objects/` belongs: asked as a file, it has a size, and a directory or nothing there has none. */
  private async rootIsAFile(): Promise<boolean> {
    return (await this.backend.size(this.at(OBJECTS_DIR))) !== null;
  }

  /** Before a write lands in `objects/`: a file where the directory belongs is not a place to put an object (§3). */
  private async checkRoot(): Promise<void> {
    if (await this.rootIsAFile()) throw new DamagedLayout(OBJECTS_DIR, OBJECTS_IS_A_FILE);
  }

  // ---- writing -----------------------------------------------------------

  async putRaw(source: ByteSource): Promise<ObjectInfo> {
    return this.put(source, null);
  }

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    return this.put(source, rawCidOf(cid)); // §6.2 step 1, before a byte is read
  }

  /**
   * The one way in (§6.1, §6.2): the source streamed into a fresh
   * staging file, hashed as it passes, refused at the chunk that
   * crosses the size bound; then, if the digest is the one wanted — or,
   * with none wanted, whatever it is — the staging file moved to its
   * object path in the store's turn. The backend makes the staging file
   * visible only once the source has ended and leaves nothing when it
   * throws, so a failure at any point leaves no object and no half of
   * one (DO-4, DO-17). The stamp is written first, then the move: a
   * crash between leaves a stamp with no object, which the next
   * collection removes; the other order could leave an object whose
   * age nothing records. A move over an object already there is the
   * same object, its bytes the ones verified now, its orphan age
   * renewed (§6.2, §9).
   */
  private async put(source: ByteSource, want: DaslCid | null): Promise<ObjectInfo> {
    await this.checkRoot(); // before a byte is read, and again before the move
    const staged = `${STAGING_DIR}/${v7()}`;
    this.staging.add(staged);
    try {
      let hashed: { cid: DaslCid; size: number } | undefined;
      await this.backend.create(
        this.at(staged),
        this.hashing(source, (result) => {
          hashed = result;
        })
      );
      const { cid, size } = hashed as { cid: DaslCid; size: number };
      try {
        if (want !== null && cid.text !== want.text) throw new DigestMismatch(want.text, cid.text); // steps 3–4: nothing accepted
        await this.serialise(async () => {
          await this.checkRoot();
          await this.backend.write(this.at(stampPath(cid.text)), new Uint8Array(0));
          await this.backend.rename(this.at(staged), this.at(objectPath(cid.text)));
        });
      } catch (err) {
        // The staging file is whole but goes nowhere: removed now, not left for the sweep.
        await this.backend.remove(this.at(staged)).catch(() => undefined);
        throw err;
      }
      return info(cid, size);
    } finally {
      this.staging.delete(staged);
    }
  }

  /** `source`'s chunks, passed through and hashed (§5); the CID and size handed to `done` after the last. */
  private async *hashing(source: ByteSource, done: (result: { cid: DaslCid; size: number }) => void): AsyncIterable<Uint8Array> {
    const hash = sha256.create();
    let size = 0;
    for await (const chunk of chunksOf(source)) {
      size += chunk.length;
      if (size > this.maxObjectBytes) throw new ObjectTooLarge(`the object is larger than the ${this.maxObjectBytes}-byte bound`);
      hash.update(chunk);
      yield chunk;
    }
    done({ cid: rawCidFromDigest(hash.digest()), size });
  }

  // ---- reading -----------------------------------------------------------

  async open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    rawCidOf(cid);
    const opened = await this.serialise(() => this.openHeld(cid));
    return opened === null ? null : opened.stream;
  }

  async read(cid: Cid, maxBytes: number): Promise<Uint8Array | null> {
    rawCidOf(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
    // Size checked and stream latched in the store's turn; the bytes come out after it (§6.3).
    const opened = await this.serialise(async () => {
      const size = await this.backend.size(this.at(objectPath(cid)));
      if (size === null) return null;
      if (size > maxBytes) throw new ObjectTooLarge(`${cid} is ${size} bytes, more than the ${maxBytes}-byte bound`); // before allocating
      return this.openHeld(cid);
    });
    if (opened === null) return null;
    // From here the stream is this method's to end: whatever fails — the
    // allocation, the stream itself — cancels it, so its latch is released.
    try {
      const out = new Uint8Array(opened.size);
      let at = 0;
      for await (const chunk of chunksOf(opened.stream)) {
        if (at + chunk.length > out.length) throw new DamagedObject(cid); // longer than its size said: not the object
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    } catch (err) {
      await opened.stream.cancel().catch(() => undefined);
      throw err;
    }
  }

  /**
   * In the store's turn: presence checked, the file opened and the latch
   * registered in one step (event-store.md §10), and a verifying stream
   * over it handed back. The latch is the stream's from here, and every
   * way it can end releases it: completion, damage, cancel, and any
   * failure — which releases before the stream fails, since an errored
   * stream runs no `cancel` and a caller can release nothing on its
   * behalf.
   */
  private async openHeld(cid: Cid): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
    const rel = objectPath(cid);
    const path = this.at(rel);
    const size = await this.backend.size(path);
    if (size === null) return null;
    const inner = await this.backend.open(path);
    if (inner === null) return null; // gone between the two looks: not this store's doing
    const release = this.latches.acquire(cid);
    try {
      return { size, stream: this.verifying(cid, inner, rel, size, release) };
    } catch (err) {
      release();
      await inner.cancel().catch(() => undefined);
      throw err;
    }
  }

  /**
   * The bytes of `inner` passed through and rehashed (§6.3): the stream
   * completes only when what came out spells `cid`; otherwise the file
   * is moved aside — if what stands there still does not spell `cid` —
   * and the stream fails with `DamagedObject` (§8.2, DO-16). Nothing is
   * pulled from the file until read (highWaterMark 0).
   */
  private verifying(cid: Cid, inner: ReadableStream<Uint8Array>, rel: string, size: number, release: () => void): ReadableStream<Uint8Array> {
    const reader = inner.getReader();
    const hash = sha256.create();
    const want = rawCidOf(cid);
    let seen = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const { done, value } = await reader.read();
            if (!done) {
              hash.update(value);
              seen += value.length;
              controller.enqueue(value);
              return;
            }
            if (seen === size && compareBytes(hash.digest(), want.digest) === 0) {
              release();
              controller.close();
              return;
            }
            await this.quarantine(cid, rel);
            release();
            controller.error(new DamagedObject(cid));
          } catch (err) {
            release();
            await reader.cancel().catch(() => undefined);
            controller.error(err);
          }
        },
        cancel: async () => {
          release();
          await reader.cancel().catch(() => undefined);
        },
      },
      { highWaterMark: 0 }
    );
  }

  /**
   * The file a read found damaged moved out of `objects/` (§9, §8.2), in
   * the store's turn, and only if what stands at its path, read again
   * now, still does not spell `cid`: a put that has since replaced it
   * with sound bytes — of the same length, in the same clock tick, even
   * — is left alone (§6.2, r1-C). Neither size nor modification time
   * tells one file from another; the bytes do.
   */
  private quarantine(cid: Cid, rel: string): Promise<void> {
    return this.serialise(async () => {
      const actual = await this.hashAt(rel);
      if (actual === null || actual.text === cid) return;
      await this.aside(rel);
    });
  }

  /** The raw CID the file at `rel` hashes to now, read whole and streamed; null when there is no file. */
  private async hashAt(rel: string): Promise<DaslCid | null> {
    const inner = await this.backend.open(this.at(rel));
    if (inner === null) return null;
    const hash = sha256.create();
    for await (const chunk of chunksOf(inner)) hash.update(chunk);
    return rawCidFromDigest(hash.digest());
  }

  /** `rel` moved to `local/damaged/objects/` under its own name, or that name with the first free numbered suffix; its stamp, if any, removed. */
  private async aside(rel: string): Promise<void> {
    const name = rel.slice(OBJECTS_DIR.length + 1);
    let target = `${DAMAGED_DIR}/${name}`;
    for (let n = 1; (await this.backend.size(this.at(target))) !== null; n++) target = `${DAMAGED_DIR}/${name}.${n}`;
    await this.backend.rename(this.at(rel), this.at(target));
    if (isRawCid(name)) await this.backend.remove(this.at(stampPath(name)));
  }

  async stat(cid: Cid): Promise<ObjectInfo | null> {
    const parsed = rawCidOf(cid);
    const size = await this.serialise(() => this.backend.size(this.at(objectPath(cid))));
    return size === null ? null : info(parsed, size);
  }

  async has(cid: Cid): Promise<boolean> {
    rawCidOf(cid);
    return (await this.serialise(() => this.backend.size(this.at(objectPath(cid))))) !== null;
  }

  async *list(): AsyncIterable<Cid> {
    const { cids } = await this.serialise(() => this.walk());
    for (const cid of cids) yield cid;
  }

  /**
   * One look at `objects/` (§9, §3): the files whose names are raw DASL
   * CIDs, in binary-CID byte order, and everything else as damage — a
   * file where the directory belongs, a file under a name that is not a
   * raw CID (a temp file a crash left, a CIDv0, an uppercase spelling, a
   * dag-pb or BLAKE3 identifier: DO-3, DO-15, VF-13), a directory
   * (VF-16). Whether a file's bytes spell its name is not looked at
   * here; that is a read's, or `verify`'s.
   */
  private async walk(): Promise<Walked> {
    const walked: Walked = { cids: [], damaged: [] };
    if (await this.rootIsAFile()) {
      walked.damaged.push({ where: OBJECTS_DIR, error: OBJECTS_IS_A_FILE });
      return walked;
    }
    const dir = this.at(OBJECTS_DIR);
    for (const name of await this.backend.list(dir)) {
      if (isRawCid(name)) walked.cids.push(name);
      else walked.damaged.push({ where: objectPath(name), error: "not an object path: the name is not a canonical raw DASL CID" });
    }
    for (const name of await this.backend.dirs(dir)) {
      walked.damaged.push({ where: objectPath(name), error: "a directory where an object belongs" });
    }
    walked.cids.sort(compareCids);
    walked.damaged.sort((a, b) => comparePaths(a.where, b.where));
    return walked;
  }

  /** What stands in `objects/` that is not an object path (§3, VF-16), each with where it stands; nothing is moved. */
  async damaged(): Promise<Damaged[]> {
    return (await this.serialise(() => this.walk())).damaged;
  }

  /**
   * Every object file read whole and rehashed, in the store's turn (§9,
   * VF-31, DO-13): one whose bytes do not spell its name is moved aside
   * and reported with the CID the bytes do have; what is in `objects/`
   * and not an object path is moved aside and reported as `damaged`
   * would; a directory there is reported and left. What comes back is
   * everything moved or reported, in path order; `objects/` afterwards
   * holds only verified objects and the directories reported.
   */
  async verify(): Promise<Damaged[]> {
    return this.serialise(async () => {
      const walked = await this.walk();
      const found: Damaged[] = [];
      for (const damage of walked.damaged) {
        found.push(damage);
        if (damage.where !== OBJECTS_DIR && (await this.backend.size(this.at(damage.where))) !== null) await this.aside(damage.where);
      }
      for (const cid of walked.cids) {
        const rel = objectPath(cid);
        const actual = await this.hashAt(rel);
        if (actual === null || actual.text === cid) continue;
        await this.aside(rel);
        found.push({ where: rel, error: `the bytes hash to ${actual.text}, not the name` });
      }
      return found.sort((a, b) => comparePaths(a.where, b.where));
    });
  }

  // ---- collection --------------------------------------------------------

  async collect(keep: Iterable<Cid>): Promise<Collected> {
    // Every keep CID checked before anything is touched (§8.3); then, in
    // the store's turn: kept and latched objects are left alone and
    // unlisted, unkept objects within grace of their stamp are `young`,
    // the rest go with their stamps — and stamps with no object, and
    // staging files a crash left, past grace, go too (§12).
    const kept = new Set<string>();
    for (const cid of keep) kept.add(rawCidOf(cid).text);
    return this.serialise(async () => {
      const now = this.now();
      const unlinked: Cid[] = [];
      const young: Cid[] = [];
      const present = new Set((await this.walk()).cids);
      for (const cid of present) {
        if (kept.has(cid) || this.latches.isLatched(cid)) continue;
        const stamp = this.at(stampPath(cid));
        let acceptedAt = await this.backend.modified(stamp);
        if (acceptedAt === null) {
          // No record of when it was accepted — `local/` was deleted, or
          // the file arrived by hand: stamped now, and young from here.
          await this.backend.write(stamp, new Uint8Array(0));
          acceptedAt = now;
        }
        if (now - acceptedAt < this.graceMs) {
          young.push(cid);
          continue;
        }
        await this.backend.remove(this.at(objectPath(cid)));
        await this.backend.remove(stamp);
        unlinked.push(cid);
      }
      for (const name of await this.backend.list(this.at(ACCEPTED_DIR))) {
        if (!present.has(name as Cid)) await this.backend.remove(this.at(`${ACCEPTED_DIR}/${name}`));
      }
      // A put in flight is left whatever stands under its staging name —
      // the file itself, or the temp file a backend writes beside it,
      // named after it — however old the clock says it is.
      const inFlight = [...this.staging].map((rel) => rel.slice(STAGING_DIR.length + 1));
      for (const name of await this.backend.list(this.at(STAGING_DIR))) {
        if (inFlight.some((staged) => name === staged || name.startsWith(`${staged}.`))) continue;
        const rel = `${STAGING_DIR}/${name}`;
        const modified = await this.backend.modified(this.at(rel));
        if (modified !== null && now - modified >= this.graceMs) await this.backend.remove(this.at(rel));
      }
      return { unlinked: sortCids(unlinked), young: sortCids(young) };
    });
  }
}

/** The stamp of `cid` (r1-D): `local/accepted/objects/<cid>`. */
function stampPath(cid: string): string {
  return `${ACCEPTED_DIR}/${cid}`;
}

function info(cid: DaslCid, size: number): ObjectInfo {
  return { cid: cid.text as Cid, codec: "raw", size };
}

function bound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} is a non-negative integer`);
  return value;
}
