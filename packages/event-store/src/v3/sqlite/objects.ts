/**
 * The version-3 object store over an open SQLite runtime: the
 * `objects` table and the chunks under each CID, 1 MiB each but the
 * last. A put is hashed as it streams into a staging table in the
 * connection's temporary database — a file of its own, never the
 * vault's, with a small page cache, where no read of the store looks
 * — under a bound on what may be staged at once, and accepted in one
 * transaction that moves the verified chunks under their CID; a vault
 * commit prepares its objects the same way and publishes them inside
 * the transaction its events land in. The connection is the runtime's,
 * synchronous and owned outright, so two writes never interleave and
 * a write is never held up by a reader: a stream open on an object
 * that a repair replaces or a collection pass removes meanwhile fails
 * at its next chunk rather than read bytes of two generations. Damage
 * is what a read finds — bytes that do not hash to the CID, a chunk
 * missing, short or surplus, a size that is no count — and is known
 * for the rest of the session, until a verified put of the CID
 * replaces the object whole.
 */

import type { DaslCid } from "@estoc/dasl";
import { compareBytes } from "@estoc/dasl";
import { sha256 } from "@noble/hashes/sha2";

import { DamagedObject, DigestMismatch, InterruptedRead, ObjectTooLarge, ReadOnlyVault, StagingFull } from "../errors.js";
import type { Cid, Damaged } from "../event.js";
import { DEFAULT_MAX_OBJECT_BYTES } from "../memory-objects.js";
import { Packer, hashSource, rawCidOf, sortCids, type ByteSource, type Collected, type ObjectInfo, type ObjectStore, type Preparation } from "../objects.js";
import { decodeText, type SqliteDriver, type SqlRow } from "./driver.js";
import type { RuntimeDatabase } from "./open.js";
import { query, run } from "./schema.js";

/** The chunk size of the format: every chunk of an object holds this many bytes but the last, which holds what remains, at least one. */
export const CHUNK_BYTES = 1024 * 1024;

/** The page cache the temporary database is allowed, in KiB: what staging may hold in memory beyond the chunk in hand before it goes to the file. */
const STAGING_CACHE_KIB = 2048;

export interface SqliteObjectStoreOptions {
  /** the largest object a put accepts; default 1 GiB */
  maxObjectBytes?: number;
  /** the most bytes staged at once across every preparation in flight, a put past it refused with `StagingFull`; default 1 GiB */
  maxStagedBytes?: number;
}

export type ObjectStoreDatabase = Pick<RuntimeDatabase, "driver" | "writable">;

/** An object verified and staged, not yet accepted: its CID and size, and the token its chunks are staged under. */
interface Staged {
  cid: DaslCid;
  size: number;
  token: number;
}

type Acceptance = "new" | "repaired" | "kept";

/** What `sound` finds under a CID: the accepted size, and the epoch a read of it belongs to. */
interface Present {
  size: number;
  epoch: number;
}

const STAGING_DDL = `CREATE TEMP TABLE IF NOT EXISTS staging_chunks (
  token    INTEGER NOT NULL,
  chunk_no INTEGER NOT NULL,
  bytes    BLOB NOT NULL,
  PRIMARY KEY (token, chunk_no)
) STRICT`;

/** Staging tokens, unique across every store of the process: the staging table is the connection's, and two stores may share one. */
let tokens = 0;

export class SqliteObjectStore implements ObjectStore {
  private readonly driver: SqliteDriver;
  private readonly writable: boolean;
  private readonly maxObjectBytes: number;
  private readonly maxStagedBytes: number;
  private staging = false;
  private readonly stagedBytesByToken = new Map<number, number>();
  private stagedBytes = 0;
  /** The objects a read of this session found damaged, by CID, with what was wrong. */
  private readonly damage = new Map<string, Damaged>();
  /**
   * Per CID, how many times this session replaced or removed what is
   * held under it; absent is zero. A stream notes the epoch it opened
   * at and fails at its next chunk once it has moved, so a repair or
   * a collection pass never has to wait for a reader, and a read never
   * completes on bytes of two generations. A rolled-back repair leaves
   * the epoch moved: a stream then fails where it could have gone on,
   * which is the explicit failure a read is allowed.
   */
  private readonly epochs = new Map<string, number>();

  constructor(db: ObjectStoreDatabase, options: SqliteObjectStoreOptions = {}) {
    this.driver = db.driver;
    this.writable = db.writable;
    this.maxObjectBytes = bound("maxObjectBytes", options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES);
    this.maxStagedBytes = bound("maxStagedBytes", options.maxStagedBytes ?? DEFAULT_MAX_OBJECT_BYTES);
  }

  async putRaw(source: ByteSource): Promise<ObjectInfo> {
    this.requireWritable("putRaw");
    return this.putAlone(undefined, source);
  }

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    const want = rawCidOf(cid);
    this.requireWritable("putObject");
    return this.putAlone(want, source);
  }

  private async putAlone(want: DaslCid | undefined, source: ByteSource): Promise<ObjectInfo> {
    const prepared = this.prepare();
    try {
      const staged = await this.stage(want, source);
      prepared.hold(staged);
      this.driver.transaction("immediate", () => prepared.publish());
      prepared.settle();
      return info(staged.cid, staged.size);
    } finally {
      prepared.discard();
    }
  }

  /**
   * A preparation over this store: what is put through it is verified
   * and staged now, seen by no read, and accepted when `publish` runs
   * inside the transaction the caller owns. See `SqlitePreparation`
   * for the steps around that transaction.
   */
  prepare(): SqlitePreparation {
    return new SqlitePreparation({
      writable: (what) => this.requireWritable(what),
      stage: (want, source) => this.stage(want, source),
      has: (cid) => this.has(cid),
      check: (cid) => {
        if (this.damage.has(cid)) throw new DamagedObject(cid);
      },
      inTransaction: () => this.driver.inTransaction,
      accept: (staged) => this.accept(staged),
      drop: (token) => this.drop(token),
      forgive: (cid) => this.damage.delete(cid),
    });
  }

  /**
   * `source` consumed, hashed and cut into chunks staged under a fresh
   * token as they stream: the chunk in hand is the one held here, and
   * the temporary database keeps its bounded cache and spills the rest
   * to its file. A source longer than the object bound stops there, and
   * one that would take what is staged across every preparation past
   * the staging bound stops before the chunk that would. The CID is
   * known at the end: for `putObject` it must be `want`, and a
   * mismatch, a source that throws or one over either bound leaves
   * nothing staged.
   */
  private async stage(want: DaslCid | undefined, source: ByteSource): Promise<Staged> {
    if (!this.staging) {
      this.driver.exec(`${STAGING_DDL}; PRAGMA temp.cache_size = -${STAGING_CACHE_KIB}`);
      this.staging = true;
    }
    const token = ++tokens;
    const insert = this.driver.prepare("INSERT INTO temp.staging_chunks (token, chunk_no, bytes) VALUES (?, ?, ?)");
    let chunkNo = 0;
    const packer = new Packer(CHUNK_BYTES, (chunk) => {
      if (this.stagedBytes + chunk.length > this.maxStagedBytes) throw new StagingFull(this.maxStagedBytes, this.stagedBytes);
      insert.run(token, chunkNo, chunk);
      chunkNo += 1;
      this.stagedBytes += chunk.length;
      this.stagedBytesByToken.set(token, (this.stagedBytesByToken.get(token) ?? 0) + chunk.length);
    });
    try {
      const got = await hashSource(source, this.maxObjectBytes, (chunk) => packer.push(chunk));
      packer.finish();
      if (want !== undefined && got.cid.text !== want.text) throw new DigestMismatch(want.text, got.cid.text);
      return { cid: got.cid, size: got.size, token };
    } catch (err) {
      this.drop(token);
      throw err;
    } finally {
      insert.finalize();
    }
  }

  private drop(token: number): void {
    if (this.staging) run(this.driver, "DELETE FROM temp.staging_chunks WHERE token = ?", token);
    this.stagedBytes -= this.stagedBytesByToken.get(token) ?? 0;
    this.stagedBytesByToken.delete(token);
  }

  /**
   * Accepts `staged` inside the caller's transaction: its chunks move
   * under its CID and the staging rows go. An object already held and
   * sound is one object still, its bytes untouched and the staged ones
   * dropped; one known damaged is replaced whole — its epoch moved so
   * a stream open on the old bytes fails rather than read on into the
   * new — and reported as a repair, for the caller to clear the damage
   * once the transaction has committed.
   */
  private accept(staged: Staged): Acceptance {
    const cid = staged.cid.text;
    const have = query(this.driver, "SELECT 1 AS present FROM objects WHERE cid = ?", cid).length === 1;
    const repair = have && this.damage.has(cid);
    if (have && !repair) {
      this.drop(staged.token);
      return "kept";
    }
    if (repair) {
      this.move(cid);
      run(this.driver, "DELETE FROM object_chunks WHERE cid = ?", cid);
      run(this.driver, "DELETE FROM objects WHERE cid = ?", cid);
    }
    run(this.driver, "INSERT INTO objects (cid, size) VALUES (?, ?)", cid, staged.size);
    run(this.driver, "INSERT INTO object_chunks (cid, chunk_no, bytes) SELECT ?, chunk_no, bytes FROM temp.staging_chunks WHERE token = ? ORDER BY chunk_no", cid, staged.token);
    this.drop(staged.token);
    return repair ? "repaired" : "new";
  }

  private move(cid: string): void {
    this.epochs.set(cid, this.epoch(cid) + 1);
  }

  private epoch(cid: string): number {
    return this.epochs.get(cid) ?? 0;
  }

  /**
   * What is accepted under `cid`, or null for absence; `DamagedObject`
   * for one known damaged. Every read starts here. The size is read as
   * its decimal text: a stored integer the platform cannot hand over
   * exactly is then this object's damage, not a failure of the read.
   */
  private sound(cid: Cid): Present | null {
    rawCidOf(cid);
    if (this.damage.has(cid)) throw new DamagedObject(cid);
    const [row] = query(this.driver, "SELECT CAST(size AS TEXT) AS size FROM objects WHERE cid = ?", cid);
    if (row === undefined) return null;
    const text = row["size"];
    const size = typeof text === "string" && /^(0|[1-9][0-9]{0,15})$/.test(text) ? Number(text) : Number.NaN;
    if (!Number.isSafeInteger(size)) {
      this.condemn(cid, `size ${String(text)} is not a count`);
      throw new DamagedObject(cid);
    }
    return { size, epoch: this.epoch(cid) };
  }

  private condemn(cid: string, error: string): void {
    this.damage.set(cid, { where: `objects/${cid}`, error });
  }

  async open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    const present = this.sound(cid);
    if (present === null) return null;
    // The stream pulls nothing until read (highWaterMark 0), one chunk
    // a pull, rehashing each on the way out; the read after the last
    // chunk verifies the size and the digest and fails on either.
    const read = new ObjectRead(cid, present);
    return new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          try {
            const chunk = this.next(read);
            if (chunk === undefined) controller.close();
            else controller.enqueue(chunk);
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
    const present = this.sound(cid);
    if (present === null) return null;
    if (present.size > maxBytes) throw new ObjectTooLarge(`${cid} is ${present.size} bytes, more than the ${maxBytes}-byte bound`); // before allocating
    const out = new Uint8Array(present.size);
    const read = new ObjectRead(cid, present);
    for (;;) {
      const chunk = this.next(read);
      if (chunk === undefined) return out;
      out.set(chunk, read.got - chunk.length);
    }
  }

  /**
   * The next chunk of `read`, or `undefined` once the object has been
   * read whole and verified as the format lays it out: chunks numbered
   * from zero, each of the chunk size but the last, which holds what
   * remains; as many chunks as that takes and no other; the bytes
   * hashing to the CID. An object that fails any of it is known damaged
   * from here on — if it is still the object the read opened on. One
   * that was replaced or removed meanwhile is a failed read, not damage.
   */
  private next(read: ObjectRead): Uint8Array | undefined {
    if (this.epoch(read.cid) !== read.epoch) throw new InterruptedRead(read.cid);
    const fail = (error: string): never => {
      this.condemn(read.cid, error);
      throw new DamagedObject(read.cid);
    };
    if (read.got < read.size) {
      // The length is asked before the bytes: a chunk longer than the layout gives it is refused without being loaded.
      const [found] = query(this.driver, "SELECT length(bytes) AS n FROM object_chunks WHERE cid = ? AND chunk_no = ?", read.cid, read.chunks);
      if (found === undefined) return fail(`chunk ${read.chunks} is missing: ${read.chunks} chunk(s) hold ${read.got} bytes of the object's ${read.size}`);
      const expected = Math.min(CHUNK_BYTES, read.size - read.got);
      if (found["n"] !== expected) return fail(`chunk ${read.chunks} holds ${String(found["n"])} bytes, not the ${expected} the layout gives it`);
      const [row] = query(this.driver, "SELECT bytes FROM object_chunks WHERE cid = ? AND chunk_no = ?", read.cid, read.chunks);
      const bytes = row?.["bytes"];
      if (!(bytes instanceof Uint8Array)) return fail(`chunk ${read.chunks} is not bytes`);
      read.chunks += 1;
      read.got += bytes.length;
      read.hash.update(bytes);
      return bytes;
    }
    const [count] = query(this.driver, "SELECT count(*) AS n FROM object_chunks WHERE cid = ?", read.cid);
    if (count?.["n"] !== read.chunks) return fail(`${String(count?.["n"])} chunk(s) are stored where the object's ${read.size} bytes take ${read.chunks}`);
    if (compareBytes(read.hash.digest(), rawCidOf(read.cid).digest) !== 0) return fail("the bytes do not hash to the CID");
    return undefined;
  }

  async stat(cid: Cid): Promise<ObjectInfo | null> {
    const present = this.sound(cid);
    return present === null ? null : info(rawCidOf(cid), present.size);
  }

  async has(cid: Cid): Promise<boolean> {
    return this.sound(cid) !== null;
  }

  async *list(): AsyncIterable<Cid> {
    // Read whole before the first yield: one cut, in binary-CID order, which is not the order the text column sorts in.
    const cids: Cid[] = [];
    for (const row of query(this.driver, "SELECT rowid AS rowid, CAST(cid AS BLOB) AS cid FROM objects")) {
      const cid = this.name(row);
      if (cid === undefined) throw new DamagedObject(`objects/rowid ${String(row["rowid"])}`);
      cids.push(cid);
    }
    for (const cid of sortCids(cids)) {
      if (this.damage.has(cid)) throw new DamagedObject(cid);
      yield cid;
    }
  }

  /** The CID a row of `objects` is keyed by, or `undefined` — and the row known damaged — when the stored text is no CID at all. */
  private name(row: SqlRow): Cid | undefined {
    const stored = row["cid"];
    try {
      if (!(stored instanceof Uint8Array)) throw new Error("the key is not text");
      return rawCidOf(decodeText(stored, "objects.cid")).text as Cid;
    } catch (err) {
      const where = `objects/rowid ${String(row["rowid"])}`;
      this.damage.set(where, { where, error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  async collect(keep: Iterable<Cid>): Promise<Collected> {
    this.requireWritable("collect");
    const kept = new Set<string>();
    for (const cid of keep) kept.add(rawCidOf(cid).text); // every keep CID checked before anything is touched
    const removed = this.driver.transaction("immediate", () => {
      const out: Cid[] = [];
      const chunks = this.driver.prepare("DELETE FROM object_chunks WHERE cid IN (SELECT cid FROM objects WHERE rowid = ?)");
      const objects = this.driver.prepare("DELETE FROM objects WHERE rowid = ?");
      try {
        for (const row of query(this.driver, "SELECT rowid AS rowid, CAST(cid AS BLOB) AS cid FROM objects")) {
          const cid = this.name(row);
          if (cid !== undefined && kept.has(cid)) continue;
          chunks.run(row["rowid"] as number);
          objects.run(row["rowid"] as number);
          if (cid === undefined) this.damage.delete(`objects/rowid ${String(row["rowid"])}`);
          else out.push(cid);
        }
      } finally {
        chunks.finalize();
        objects.finalize();
      }
      return out;
    });
    // Committed: what was removed is gone for every read from here, its damage with it.
    for (const cid of removed) {
      this.move(cid);
      this.damage.delete(cid);
    }
    return { removed: sortCids(removed) };
  }

  /** The damage this session has found: each object by CID, or by rowid when its key is no CID, and what was wrong. Nothing is persisted; a reopen finds it again. */
  async damaged(): Promise<Damaged[]> {
    return [...this.damage.values()];
  }

  private requireWritable(what: string): void {
    if (!this.writable) throw new ReadOnlyVault(what);
  }
}

/** The steps a preparation takes on its store, which `SqliteObjectStore.prepare` closes over its own: no part of the store's interface. */
export interface PreparationSteps {
  writable(what: string): void;
  stage(want: DaslCid | undefined, source: ByteSource): Promise<Staged>;
  has(cid: Cid): Promise<boolean>;
  /** Throws `DamagedObject` for an object the store knows damaged; nothing otherwise. */
  check(cid: Cid): void;
  inTransaction(): boolean;
  accept(staged: Staged): Acceptance;
  drop(token: number): void;
  forgive(cid: string): void;
}

/**
 * The objects of one commit between verification and publication,
 * staged in the connection's temporary database where no read of the
 * store sees them, and accepted by three steps around the transaction
 * the commit lands in: `publish` inside it, checking every object
 * declared reused against the damage known by then and moving every
 * staged object under its CID; `settle` once it has committed,
 * clearing the damage of the objects it repaired — inside the
 * transaction that would be too soon, since a rollback keeps the old
 * bytes and their damage — and `discard` in any case, dropping
 * whatever is still staged. A preparation dropped unpublished leaves
 * the store as it was; two in flight are two, each publishing only
 * what it verified.
 */
export class SqlitePreparation implements Preparation {
  private readonly staged = new Map<string, Staged>();
  private readonly reused = new Set<string>();
  private repaired: string[] = [];

  constructor(private readonly steps: PreparationSteps) {}

  async putObject(cid: Cid, source: ByteSource): Promise<ObjectInfo> {
    const want = rawCidOf(cid);
    this.steps.writable("putObject");
    const staged = await this.steps.stage(want, source);
    this.hold(staged);
    return info(staged.cid, staged.size);
  }

  /** Holds `staged` for `publish`; a second staging of one CID replaces the first, whose chunks are dropped. */
  hold(staged: Staged): void {
    const before = this.staged.get(staged.cid.text);
    if (before !== undefined) this.steps.drop(before.token);
    this.staged.set(staged.cid.text, staged);
  }

  async has(cid: Cid): Promise<boolean> {
    rawCidOf(cid);
    return this.staged.has(cid) || this.steps.has(cid);
  }

  reuse(cid: Cid): void {
    rawCidOf(cid);
    this.reused.add(cid);
  }

  /** Checks every object declared reused, then accepts every staged object, inside the caller's transaction; a repair among them is noted for `settle`. Returns how many landed — new or repaired — as opposed to being dropped for an object already held sound. */
  publish(): number {
    if (!this.steps.inTransaction()) throw new Error("a preparation publishes inside the transaction its commit lands in");
    for (const cid of this.reused) if (!this.staged.has(cid)) this.steps.check(cid as Cid);
    let landed = 0;
    for (const staged of this.staged.values()) {
      const accepted = this.steps.accept(staged);
      if (accepted === "repaired") this.repaired.push(staged.cid.text);
      if (accepted !== "kept") landed += 1;
    }
    return landed;
  }

  /** After the transaction committed: the repaired objects are sound again, and nothing is staged. */
  settle(): void {
    for (const cid of this.repaired) this.steps.forgive(cid);
    this.repaired = [];
    this.staged.clear();
    this.reused.clear();
  }

  /** Drops whatever is still staged: what an unpublished or rolled-back preparation leaves; nothing after `settle`. */
  discard(): void {
    for (const staged of this.staged.values()) this.steps.drop(staged.token);
    this.staged.clear();
    this.reused.clear();
    this.repaired = [];
  }
}

class ObjectRead {
  readonly size: number;
  readonly epoch: number;
  readonly hash = sha256.create();
  chunks = 0;
  got = 0;

  constructor(
    readonly cid: Cid,
    present: Present
  ) {
    this.size = present.size;
    this.epoch = present.epoch;
  }
}

function info(cid: DaslCid, size: number): ObjectInfo {
  return { cid: cid.text as Cid, codec: "raw", size };
}

function bound(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} is a non-negative integer`);
  return value;
}
