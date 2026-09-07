/**
 * The vault, version 3 (event-store.md §10): what a program gets —
 * events to read, objects to read, portable files, and `commit` — and
 * what the runtime underneath keeps to itself: the vault-wide writer
 * lock, the read latch, `ingest`, and collection, whose keep set is
 * computed only under the lock. The interfaces every backend presents,
 * the facade that takes the lock on each operation and the view that
 * shares one held lock, and the vault in memory: the reference, the
 * vault the folds are tested on, and the far end of the round trip.
 */

import { MissingRoot, ObjectTooLarge } from "./errors.js";
import { canonicalEvent, validateDraft, type AuthorId, type Cid, type Draft, type Event, type EventStore, type Ingested, type Rejected } from "./event.js";
import { MemoryFileStore, type FileStore } from "./files.js";
import type { JsonObject } from "./json.js";
import { MemoryEventStore } from "./memory-events.js";
import { MemoryObjectStore } from "./memory-objects.js";
import { LatchRegistry, chunksOf, rawCidOf, sortCids, type ByteSource, type Collected, type ObjectStore } from "./objects.js";

/** An object handed to `commit` (§10): the bytes, and the raw CID they must hash to. */
export type CommitObject = { cid: Cid; source: ByteSource };

/** The events as application code reads them (§10): no `append`, `appendAll` or `ingest` (ES-29). */
export type VaultEvents = Pick<EventStore, "scan" | "changes" | "damaged" | "conflicting">;
/** The objects as application code reads them (§10): no put and no collection (ES-29). */
export type VaultObjects = Omit<ObjectStore, "putRaw" | "putObject" | "collect">;

/**
 * The vault to a program (§10). Every local event write goes through
 * `commit`, with or without new objects; every mutation takes the
 * vault-wide writer lock; an object read latches its CID against
 * collection for the life of the stream, and no longer holds the lock.
 */
export interface Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;
  readonly files: FileStore;
  /**
   * Under the writer lock: validate every draft, accept every supplied
   * object under `putObject`'s rules, require every draft root — new or
   * reused — to name a present accepted object, then append the drafts
   * as one all-or-nothing batch and return the events (§10, §5.2). A
   * failure at any step appends nothing; an object accepted before it
   * stays, an orphan under grace (dasl-objects.md §8.1).
   */
  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}

/**
 * The keep set for one collection pass (dasl-objects.md §8.3), computed
 * by the caller while the pass holds the writer lock (§10): what the
 * vault runtime folds from the events it reads through `held` — a
 * set computed before the lock was taken cannot be handed in, which is
 * the rule made a type. The object store checks each CID.
 */
export type KeepUnderLock = (held: Held) => Promise<Iterable<Cid>> | Iterable<Cid>;

/**
 * The vault as an operation holding the writer lock sees it (§10):
 * the same interface, every call sharing the held lock instead of
 * taking it — a read nested inside a commit, an import or an export
 * neither waits for itself nor shortens the operation's boundary —
 * plus the primitives the runtime keeps from application code.
 */
export interface Held extends Vault {
  /** The store's `ingest` (§5.3), for validated import and restore. */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** One collection pass (dasl-objects.md §8.3): `keep` is called here, under the lock, then the unkept are collected. */
  collect(keep: KeepUnderLock): Promise<Collected>;
  /** Run `op` under the lock already held: nested, shares it. */
  locked<T>(op: (held: Held) => Promise<T>): Promise<T>;
}

/**
 * What a host opens (§10, last paragraph): a backend with its local
 * replica context — author and store generation — that hands out the
 * `Vault` application code gets and keeps the writer lock, `ingest` and
 * collection for the runtime above it.
 */
export interface VaultRuntime {
  /** The local replica every committed event is authored as (§4.1). */
  readonly author: AuthorId;
  /** The store generation this runtime's change tokens name (§5.5). */
  readonly generation: string;
  /** The vault, as application code gets it: each operation takes the writer lock for itself. */
  readonly vault: Vault;
  /** Run `op` under the vault-wide writer lock, serialized with every other mutation; `op` works through the held view. */
  locked<T>(op: (held: Held) => Promise<T>): Promise<T>;
  /** One collection pass under the lock: `keep` is computed inside it (§10, DO-19). */
  collect(keep: KeepUnderLock): Promise<Collected>;
  /** Ingest under the lock (§5.3, §10): the input is read whole first, then classified and accepted while nothing else writes. */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
}

// ---- the lock -----------------------------------------------------------

/**
 * The vault-wide writer lock (§10) for one runtime in one process:
 * operations run one at a time in the order they arrived, each holding
 * it from its first step to its last, whatever it awaits meanwhile.
 * Nesting is not this class's: an operation that needs the lock it
 * already holds works through `Held`.
 */
export class WriterLock {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;

  run<T>(op: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => {
        this.holders += 1;
        return op();
      })
      .finally(() => {
        this.holders -= 1;
        release();
      });
  }

  /** Is an operation holding the lock right now? For diagnostics and tests. */
  get held(): boolean {
    return this.holders > 0;
  }
}

// ---- the views ----------------------------------------------------------

/** The backend stores a runtime is built over. */
export interface Stores {
  events: EventStore;
  objects: ObjectStore;
  files: FileStore;
}

/** How a view enters the lock: by taking it, or — already inside — by doing nothing. */
type Enter = <T>(op: () => Promise<T>) => Promise<T>;

/**
 * One view of the stores (§10): the facade application code gets, when
 * `enter` takes the lock, or the view an operation works through while
 * holding it, when `enter` is immediate. Reads of events, of object
 * metadata and of files take no lock; `open` takes it for the presence
 * check and latch registration and releases it before the stream is
 * consumed; `read` is `open` drained outside the lock, refused before
 * allocation when the object is larger than `maxBytes`; every mutation
 * runs under it whole.
 */
class View implements Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;
  readonly files: FileStore;

  constructor(
    protected readonly stores: Stores,
    protected readonly enter: Enter
  ) {
    const { events, objects, files } = stores;
    this.events = {
      scan: (filter) => events.scan(filter),
      changes: (filter, since) => events.changes(filter, since),
      damaged: () => events.damaged(),
      conflicting: () => events.conflicting(),
    };
    this.objects = {
      open: (cid) => this.open(cid),
      read: (cid, maxBytes) => this.read(cid, maxBytes),
      stat: (cid) => objects.stat(cid),
      has: (cid) => objects.has(cid),
      list: () => objects.list(),
    };
    this.files = {
      read: (path) => files.read(path),
      write: (path, bytes) => enter(() => files.write(path, bytes)),
      list: () => files.list(),
    };
  }

  private open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    return this.enter(() => this.stores.objects.open(cid));
  }

  private async read(cid: Cid, maxBytes: number): Promise<Uint8Array | null> {
    rawCidOf(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
    // Size checked and stream latched under the lock; the bytes come out after it (§10, dasl-objects.md §6.3).
    const opened = await this.enter(async () => {
      const info = await this.stores.objects.stat(cid);
      if (info === null) return null;
      if (info.size > maxBytes) throw new ObjectTooLarge(`${cid} is ${info.size} bytes, more than the ${maxBytes}-byte bound`);
      const stream = await this.stores.objects.open(cid);
      return stream === null ? null : { stream, size: info.size };
    });
    if (opened === null) return null;
    // From here the stream is this method's to end: whatever fails —
    // the allocation, the stream itself — cancels it, so its latch is
    // released on every failure path (§10), not only the ones inside
    // the iteration.
    try {
      const out = new Uint8Array(opened.size);
      let at = 0;
      for await (const chunk of chunksOf(opened.stream)) {
        if (at + chunk.length > out.length) throw new ObjectTooLarge(`${cid} streamed more than its ${opened.size} bytes`);
        out.set(chunk, at);
        at += chunk.length;
      }
      return out;
    } catch (err) {
      await opened.stream.cancel().catch(() => undefined);
      throw err;
    }
  }

  commit<D extends JsonObject>(objects: CommitObject[], drafts: Draft<D>[]): Promise<Event<D>[]> {
    return this.enter(async () => {
      // Every draft and every CID checked before a byte is read (§10):
      // a bad batch accepts nothing.
      const clean = drafts.map((draft) => validateDraft(draft));
      for (const object of objects) rawCidOf(object.cid);
      for (const object of objects) await this.stores.objects.putObject(object.cid, object.source);
      for (const root of sortCids(clean.flatMap((draft) => draft.roots))) {
        if (!(await this.stores.objects.has(root))) throw new MissingRoot(root);
      }
      return this.stores.events.appendAll(clean) as Promise<Event<D>[]>;
    });
  }
}

/**
 * The view an operation works through while it holds the lock: the
 * vault's members entering nothing, plus the runtime's primitives. One
 * per runtime; handed to every locked operation and every keep
 * computation.
 */
class HeldView extends View implements Held {
  constructor(stores: Stores) {
    super(stores, (op) => op());
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    return ingestRead(this.stores.events, await readAll(events));
  }

  async collect(keep: KeepUnderLock): Promise<Collected> {
    return this.stores.objects.collect(await keep(this));
  }

  locked<T>(op: (held: Held) => Promise<T>): Promise<T> {
    return op(this);
  }
}

/** The input of `ingest`, read whole: the events fixed in canonical form, and the inputs that were not events, with why. */
interface Read {
  events: Event[];
  rejected: Rejected[];
}

/**
 * The input of `ingest`, read whole before the lock is taken (§5.3):
 * its validation is its own, and a slow source should not hold the
 * vault. Each input is fixed — validated and copied into canonical
 * form, or recorded as rejected with its error — before the source is
 * asked for the next, so a source that reuses one object between
 * yields is read as it yielded, and what reaches the store is the
 * runtime's own data, which nothing outside can change.
 */
async function readAll(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Read> {
  const read: Read = { events: [], rejected: [] };
  for await (const value of events) {
    try {
      read.events.push(canonicalEvent(value));
    } catch (err) {
      read.rejected.push({ value, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return read;
}

/** Ingest what `readAll` read: the events to the store, under the lock the caller holds; the rejected reported with the store's own. */
async function ingestRead(events: EventStore, read: Read): Promise<Ingested> {
  const outcome = await events.ingest(read.events);
  return read.rejected.length === 0 ? outcome : { ...outcome, rejected: [...read.rejected, ...outcome.rejected] };
}

/**
 * A runtime over any three stores, for one process: the lock, the
 * facade application code gets — a `Vault` with nothing else on it
 * (ES-29) — and the held view. What `MemoryVault` is, and what a folder
 * backend builds once it has opened its stores.
 */
export class Runtime implements VaultRuntime {
  readonly lock = new WriterLock();
  readonly vault: Vault;
  private readonly held: HeldView;

  /**
   * `guard` runs as each operation asks for the lock, before it queues:
   * a runtime that can be closed throws from it once it is, so nothing
   * queued after the close runs on a folder another process may own by
   * then. An operation already inside the lock is not asked again.
   */
  constructor(
    readonly author: AuthorId,
    readonly generation: string,
    readonly stores: Stores,
    private readonly guard: () => void = () => undefined
  ) {
    this.held = new HeldView(stores);
    this.vault = new View(stores, (op) => this.enter(op));
  }

  private enter<T>(op: () => Promise<T>): Promise<T> {
    try {
      this.guard();
    } catch (err) {
      return Promise.reject(err); // a refusal is a rejection, as every other failure of the operation is
    }
    return this.lock.run(op);
  }

  locked<T>(op: (held: Held) => Promise<T>): Promise<T> {
    return this.enter(() => op(this.held));
  }

  collect(keep: KeepUnderLock): Promise<Collected> {
    return this.locked((held) => held.collect(keep));
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    this.guard(); // inside an async function: a throw here is this promise's rejection
    const read = await readAll(events);
    return this.locked(() => ingestRead(this.stores.events, read));
  }
}

// ---- in memory ----------------------------------------------------------

export interface MemoryVaultOptions {
  /** the author every committed event carries (§4.1); a fresh UUIDv7 when left out */
  author?: AuthorId;
  /** the wall clock in Unix milliseconds, for `at` and for orphan age; default `Date.now`, pinned by tests */
  now?: () => number;
  /** orphan grace (dasl-objects.md §8.3); default one hour */
  graceMs?: number;
  /** the largest object a commit accepts (dasl-objects.md §12); default 1 GiB */
  maxObjectBytes?: number;
  /** the size of the internal extents an object is held in; default 1 MiB */
  extentBytes?: number;
}

/**
 * The vault as maps in memory: `MemoryEventStore`, `MemoryObjectStore`
 * and `MemoryFileStore` under one runtime, one lock and one latch
 * registry. Nothing persists, so the process-durable half of §2.1 is
 * vacuous; the boundaries are not: a commit is all or nothing, a paused
 * stream blocks no writer and protects its object, collection waits for
 * the commit in flight and computes its keep set only once it has the
 * lock.
 */
export class MemoryVault extends Runtime {
  declare readonly stores: { events: MemoryEventStore; objects: MemoryObjectStore; files: MemoryFileStore };
  /** the read latches over this vault's objects (§10) */
  readonly latches: LatchRegistry;

  constructor(options: MemoryVaultOptions = {}) {
    const latches = new LatchRegistry();
    const now = options.now === undefined ? {} : { now: options.now };
    const events = new MemoryEventStore({ ...now, ...(options.author === undefined ? {} : { author: options.author }) });
    const objects = new MemoryObjectStore({
      ...now,
      latches,
      ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.extentBytes === undefined ? {} : { extentBytes: options.extentBytes }),
    });
    super(events.author, events.generation, { events, objects, files: new MemoryFileStore() });
    this.latches = latches;
  }
}
