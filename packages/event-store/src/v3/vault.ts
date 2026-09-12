/**
 * The vault, version 3: what a program gets — its metadata, events to
 * read, objects to read, and `commit` — and what the runtime underneath
 * keeps to itself: the vault-wide writer lock, the keystore, `ingest`,
 * and collection, whose keep set is computed only under the lock. The
 * interfaces every backend presents, the facade that takes the lock on
 * each operation and the view that shares one held lock, and the vault
 * in memory: the reference, the vault the folds are tested on, and the
 * far end of the round trip.
 */

import { MissingRoot, NotAVault, ObjectTooLarge, UnreferencedObject, UnsupportedOperation } from "./errors.js";
import { canonicalEvent, validateDraft, type AuthorId, type Cid, type Draft, type Event, type EventStore, type EventTally, type Ingested, type Rejected } from "./event.js";
import type { JsonObject } from "./json.js";
import { checkMetadata, checkWrappedSeed, type KeystoreAccess, type VaultMetadata, type WrappedSeed } from "./keystore.js";
import { MemoryEventStore } from "./memory-events.js";
import { MemoryObjectStore } from "./memory-objects.js";
import { chunksOf, rawCidOf, sortCids, type ByteSource, type Collected, type ObjectStore, type Preparation } from "./objects.js";

/** An object handed to `commit`: the bytes, and the raw CID they must hash to. */
export type CommitObject = { cid: Cid; source: ByteSource };

/** The events as application code reads them: no `append`, `appendAll` or `ingest`. */
export type VaultEvents = Pick<EventStore, "scan" | "changes" | "damaged" | "conflicting">;
/** The objects as application code reads them: no put and no collection. */
export type VaultObjects = Omit<ObjectStore, "putRaw" | "putObject" | "collect">;

/**
 * The vault to a program. Every local event write goes through
 * `commit`, with or without new objects; every mutation takes the
 * vault-wide writer lock; a read of events or object metadata takes
 * none, and an object stream holds it only for its presence check.
 */
export interface Vault {
  /** The vault's identity, the same in every copy; never changes while open. */
  readonly metadata: VaultMetadata;
  readonly events: VaultEvents;
  readonly objects: VaultObjects;
  /**
   * Under the writer lock: validate every draft and every CID, refuse
   * a supplied object no draft names as a root (`UnreferencedObject`)
   * before reading a byte, accept every supplied object under
   * `putObject`'s rules, require every draft root — new or reused — to
   * name a present accepted object (`MissingRoot` otherwise), then
   * append the drafts as one all-or-nothing batch and return the
   * events. A failure at any step publishes nothing: no object, no
   * repair, no event.
   */
  commit(objects: CommitObject[], drafts: Draft[]): Promise<Event[]>;
}

/**
 * The keep set for one collection pass, computed by the caller while
 * the pass holds the writer lock: what the vault runtime folds from the
 * events it reads through `held` — a set computed before the lock was
 * taken cannot be handed in, which is the rule made a type. The view
 * `keep` gets is for reading: a mutation through it is refused, since
 * it would wait on the pass that is waiting on `keep`. The object store
 * checks each CID.
 */
export type KeepUnderLock = (held: Held) => Promise<Iterable<Cid>> | Iterable<Cid>;

/**
 * The roots the events of a vault hold, folded from what it reads
 * through `vault`: what an export copies, and what a snapshot must
 * hold exactly to validate. Computed by the caller, since only the
 * vault's own folds know which roots an event retains and which it
 * released; the runtime checks each CID. A `HeldRoots` serves as a
 * `KeepUnderLock` too, reading through the held view. Whether every
 * known payload is valid is decided here as well, by the layer that
 * knows them: what the fold throws is what the export or validation
 * fails with.
 */
export type HeldRoots = (vault: Vault) => Promise<Iterable<Cid>> | Iterable<Cid>;

/**
 * The vault as an operation holding the writer lock sees it: the same
 * interface, every call sharing the held lock instead of taking it — a
 * read nested inside a commit, an import or an export neither waits for
 * itself nor shortens the operation's boundary — plus the primitives
 * the runtime keeps from application code. The mutations the operation
 * issues through it — `commit`, `ingest`, `collect` — run one at a
 * time in the order issued, each whole from its first step to its last,
 * as the lock runs operations: a commit issued while a collection pass
 * computes its keep set lands after the pass, so what the pass decided
 * to keep is what it deletes against. The view lives as long as the
 * operation, which ends in two steps. Once the operation's callback
 * has returned, the view accepts no further mutation, but a mutation
 * it issued and did not wait for still finishes before the lock is
 * released, and reads through the view — a collection pass computing
 * its keep set, nested reads included — stay good until it has. Once
 * the last has finished, the view refuses every call, reads included,
 * since it is no longer inside the lock and no longer the runtime's to
 * check.
 */
export interface Held extends Vault {
  /** The store's `ingest`, for validated import and restore. */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** One collection pass: `keep` is called here, under the lock, then the unkept are deleted. */
  collect(keep: KeepUnderLock): Promise<Collected>;
  /** Run `op` under the lock already held: nested, shares it. */
  locked<T>(op: (held: Held) => Promise<T>): Promise<T>;
  /** The store's `tally`: what an export bounds itself by before it reads an event. */
  tally(): Promise<EventTally>;
}

/**
 * What a host opens: a backend with its local replica context — author
 * and store generation — that hands out the `Vault` application code
 * gets and keeps the writer lock, the keystore, `ingest` and collection
 * for the runtime above it.
 */
export interface VaultRuntime {
  /** The local replica every committed event is authored as. */
  readonly author: AuthorId;
  /** The store generation this runtime's change tokens name. */
  readonly generation: string;
  /** The vault's identity; the same object `vault.metadata` is. */
  readonly metadata: VaultMetadata;
  /** The wrapped seed: read by whoever unlocks, rewrapped under the lock. */
  readonly keystore: KeystoreAccess;
  /** The vault, as application code gets it: each operation takes the writer lock for itself. */
  readonly vault: Vault;
  /** Run `op` under the vault-wide writer lock, serialized with every other mutation; `op` works through the held view. */
  locked<T>(op: (held: Held) => Promise<T>): Promise<T>;
  /** One collection pass under the lock: `keep` is computed inside it. */
  collect(keep: KeepUnderLock): Promise<Collected>;
  /** Ingest under the lock: the input is read whole first, then classified and accepted while nothing else writes. */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
}

// ---- the lock -----------------------------------------------------------

/**
 * Operations run one at a time in the order they arrived, each holding
 * the lock from its first step to its last, whatever it awaits
 * meanwhile: the vault-wide writer lock of one runtime in one process,
 * and, inside one operation, the order of the mutations it issues
 * through `Held`. Nesting is not this class's: an operation that needs
 * the lock it already holds works through `Held`.
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

  /** Resolved once every operation queued so far has finished, however it ended. */
  idle(): Promise<void> {
    return this.tail;
  }

  /** Is an operation holding the lock right now? For diagnostics and tests. */
  get held(): boolean {
    return this.holders > 0;
  }
}

// ---- the views ----------------------------------------------------------

/**
 * The backend stores a runtime is built over, and the transaction a
 * commit publishes in. `body` prepares the commit's objects through
 * `prepared` — verified, held where no read sees them — and returns
 * the drafts to append; then the prepared objects, the repairs among
 * them and the events publish as one, or, on a throw from `body` or
 * from the append, nothing does. No backend publishes as it goes: a
 * runtime refuses stores without it.
 */
export interface Stores {
  events: EventStore;
  objects: ObjectStore;
  transaction<D extends JsonObject>(body: (prepared: Preparation) => Promise<Draft<D>[]>): Promise<Event<D>[]>;
}

/** How a view enters the lock: by taking it, or — already inside — by doing nothing. */
type Enter = <T>(op: () => Promise<T>) => Promise<T>;

/** What a view does around each mutation: the facade takes the lock; the held view queues it behind the operation's other mutations; a keep callback's view refuses it. */
type Mutate = Enter;

/**
 * The span of one operation under the lock, as its held views see it,
 * with two boundaries rather than one. When the operation's callback
 * has returned, it accepts no further mutation — the tail `end` waits
 * on would otherwise grow behind it — while the mutations accepted
 * before still run, and reads through its views stay good meanwhile,
 * since the lock is still held: a collection pass queued or in flight
 * computes its keep set through them. When the last accepted mutation
 * has finished, the operation has ended, the lock is released after
 * it, and a view kept past it refuses every call — it would otherwise
 * run without the lock, and read past the runtime's guard.
 */
class Operation {
  private readonly mutations = new WriterLock();
  private returned = false;
  private ended = false;

  check(): void {
    if (this.ended) throw new UnsupportedOperation("a call through a held view after its operation ended");
  }

  async enter<T>(op: () => Promise<T>): Promise<T> {
    this.check();
    return op();
  }

  async mutate<T>(op: () => Promise<T>): Promise<T> {
    this.check();
    if (this.returned) throw new UnsupportedOperation("a mutation through a held view after its operation returned");
    return this.mutations.run(op);
  }

  async end(): Promise<void> {
    this.returned = true;
    await this.mutations.idle();
    this.ended = true;
  }
}

function refuse<T>(what: string): Promise<T> {
  return Promise.reject(new UnsupportedOperation(what));
}

/** What each read that takes no lock asks first: nothing, or a throw refusing it. */
type Check = () => void;

/**
 * One view of the stores: the facade application code gets, when
 * `enter` takes the lock, or the view an operation works through while
 * holding it, when `enter` is immediate. Reads of events and of object
 * metadata take no lock; `open` takes it for the presence check and
 * releases it before the stream is consumed; `read` is `open` drained
 * outside the lock, refused before allocation when the object is larger
 * than `maxBytes`; every mutation runs whole inside `mutate`.
 */
class View implements Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;

  constructor(
    protected readonly stores: Stores,
    readonly metadata: VaultMetadata,
    protected readonly enter: Enter,
    protected readonly mutate: Mutate,
    check: Check = () => undefined
  ) {
    const { events, objects } = stores;
    this.events = {
      scan: async function* (filter) {
        check();
        yield* events.scan(filter);
      },
      changes: async (filter, since) => {
        check();
        return events.changes(filter, since);
      },
      damaged: async () => {
        check();
        return events.damaged();
      },
      conflicting: async () => {
        check();
        return events.conflicting();
      },
    };
    this.objects = {
      open: (cid) => this.open(cid),
      read: (cid, maxBytes) => this.read(cid, maxBytes),
      stat: async (cid) => {
        check();
        return objects.stat(cid);
      },
      has: async (cid) => {
        check();
        return objects.has(cid);
      },
      list: async function* () {
        check();
        yield* objects.list();
      },
    };
  }

  private open(cid: Cid): Promise<ReadableStream<Uint8Array> | null> {
    return this.enter(() => this.stores.objects.open(cid));
  }

  private async read(cid: Cid, maxBytes: number): Promise<Uint8Array | null> {
    rawCidOf(cid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes is a non-negative integer");
    // Size checked and stream opened under the lock; the bytes come out after it.
    const opened = await this.enter(async () => {
      const info = await this.stores.objects.stat(cid);
      if (info === null) return null;
      if (info.size > maxBytes) throw new ObjectTooLarge(`${cid} is ${info.size} bytes, more than the ${maxBytes}-byte bound`);
      const stream = await this.stores.objects.open(cid);
      return stream === null ? null : { stream, size: info.size };
    });
    if (opened === null) return null;
    // From here the stream is this method's to end: whatever fails —
    // the allocation, the stream itself — cancels it.
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
    return this.mutate(async () => {
      // The batch is fixed first — the drafts validated into copies,
      // the object descriptors copied — so what is checked is what is
      // read: a source that grows the caller's array or rewrites a
      // later descriptor while it streams changes nothing here. Every
      // draft and every CID is checked, and every supplied object
      // matched to a root, before a byte is read: a bad batch accepts
      // nothing. `Array.from` visits every index, so a hole in a
      // sparse array is refused like any value that is not a draft or
      // a descriptor.
      const clean = Array.from(drafts, (draft) => validateDraft(draft));
      const batch = Array.from(objects, (object) => ({ cid: object.cid, source: object.source }));
      const roots = new Set<Cid>(clean.flatMap((draft) => draft.roots));
      for (const object of batch) {
        rawCidOf(object.cid);
        if (!roots.has(object.cid)) throw new UnreferencedObject(object.cid);
      }
      return this.stores.transaction<D>(async (prepared) => {
        for (const object of batch) await prepared.putObject(object.cid, object.source);
        for (const root of sortCids(roots)) {
          if (!(await prepared.has(root))) throw new MissingRoot(root);
        }
        return clean as Draft<D>[];
      });
    });
  }
}

function refuseInKeep<T>(): Promise<T> {
  return refuse("a mutation inside a keep callback");
}

/**
 * The view an operation works through while it holds the lock: the
 * vault's members entering nothing, its mutations queued one behind
 * another, plus the runtime's primitives. One per locked operation,
 * living as long as it; the keep callback of each collection pass gets
 * `reading`, the same view with its mutations refused.
 */
class HeldView extends View implements Held {
  private readonly reading: Held;

  static forOperation(stores: Stores, metadata: VaultMetadata, operation: Operation): HeldView {
    const enter: Enter = (op) => operation.enter(op);
    const check: Check = () => operation.check();
    return new HeldView(stores, metadata, enter, (op) => operation.mutate(op), check, new HeldView(stores, metadata, enter, refuseInKeep, check));
  }

  private constructor(stores: Stores, metadata: VaultMetadata, enter: Enter, mutate: Mutate, check: Check, reading?: Held) {
    super(stores, metadata, enter, mutate, check);
    this.reading = reading ?? this;
  }

  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    return this.mutate(async () => ingestRead(this.stores.events, await readAll(events)));
  }

  collect(keep: KeepUnderLock): Promise<Collected> {
    return this.mutate(async () => this.stores.objects.collect(await keep(this.reading)));
  }

  locked<T>(op: (held: Held) => Promise<T>): Promise<T> {
    return this.enter(() => op(this));
  }

  tally(): Promise<EventTally> {
    return this.enter(() => this.stores.events.tally());
  }
}

/** The input of `ingest`, read whole: the events fixed in canonical form, and the inputs that were not events, with why. */
interface Read {
  events: Event[];
  rejected: Rejected[];
}

/**
 * The input of `ingest`, read whole before any of it is classified —
 * by the runtime before it takes the lock, since a slow source should
 * not hold the vault, and by a held view in its turn among the
 * operation's mutations. Each input is fixed — validated and copied into canonical form, or
 * recorded as rejected with its error — before the source is asked for
 * the next, so a source that reuses one object between yields is read
 * as it yielded, and what reaches the store is the runtime's own data,
 * which nothing outside can change.
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

// ---- the runtime --------------------------------------------------------

export interface RuntimeOptions {
  author: AuthorId;
  generation: string;
  metadata: VaultMetadata;
  stores: Stores;
  /** The keystore over the runtime's lock: called once, with the runtime whose `locked` a rewrap runs under. */
  keystore: (runtime: VaultRuntime) => KeystoreAccess;
  /**
   * Asked as each operation asks for the lock, before it queues
   * (`"enter"`), again as it takes the lock (`"run"`), and by each read
   * that takes no lock (`"read"`). A runtime that can be closed throws
   * from `"enter"` once it is, so nothing queued after the close runs on
   * a vault another process may own by then, while what was accepted
   * before runs out; one that has been halted throws from all three, so
   * nothing accepted earlier runs either. An operation already inside
   * the lock is not asked again.
   */
  guard?: (when: "enter" | "run" | "read") => void;
}

/**
 * A runtime over any two stores and their transaction, for one
 * process: the lock, the facade application code gets — a `Vault` with
 * nothing else on it — and the held view. What `MemoryVault` is, and
 * what a persistent backend builds once it has opened its stores.
 */
export class Runtime implements VaultRuntime {
  readonly lock = new WriterLock();
  readonly author: AuthorId;
  readonly generation: string;
  readonly metadata: VaultMetadata;
  readonly keystore: KeystoreAccess;
  readonly stores: Stores;
  readonly vault: Vault;
  private readonly guard: (when: "enter" | "run" | "read") => void;

  constructor(options: RuntimeOptions) {
    if (typeof options.stores.transaction !== "function") throw new TypeError("a runtime's stores publish a commit in one transaction: `transaction` is missing");
    this.author = options.author;
    this.generation = options.generation;
    this.metadata = checkMetadata(options.metadata);
    this.stores = options.stores;
    this.guard = options.guard ?? (() => undefined);
    this.vault = new View(
      this.stores,
      this.metadata,
      (op) => this.enter(op),
      (op) => this.enter(op),
      () => this.guard("read")
    );
    this.keystore = options.keystore(this);
  }

  private enter<T>(op: () => Promise<T>): Promise<T> {
    try {
      this.guard("enter");
    } catch (err) {
      return Promise.reject(err); // a refusal is a rejection, as every other failure of the operation is
    }
    return this.lock.run(() => {
      this.guard("run");
      return op();
    });
  }

  locked<T>(op: (held: Held) => Promise<T>): Promise<T> {
    return this.enter(async () => {
      const operation = new Operation();
      try {
        return await op(HeldView.forOperation(this.stores, this.metadata, operation));
      } finally {
        await operation.end();
      }
    });
  }

  collect(keep: KeepUnderLock): Promise<Collected> {
    return this.locked((held) => held.collect(keep));
  }

  async ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested> {
    this.guard("enter"); // inside an async function: a throw here is this promise's rejection
    const read = await readAll(events);
    return this.locked(() => ingestRead(this.stores.events, read));
  }
}

// ---- in memory ----------------------------------------------------------

export interface MemoryVaultOptions {
  /** the vault's identity: version 3 and its anchor DID */
  metadata: VaultMetadata;
  /** the wrapped seed the keystore hands out; a vault given none refuses to read it */
  wrapped?: WrappedSeed;
  /** the author every committed event carries; a fresh UUIDv7 when left out */
  author?: AuthorId;
  /** the wall clock in Unix milliseconds, for `at`; default `Date.now`, pinned by tests */
  now?: () => number;
  /** the largest object a commit accepts; default 1 GiB */
  maxObjectBytes?: number;
  /** the size of the internal extents an object is held in; default 1 MiB */
  extentBytes?: number;
}

/**
 * The wrapped seed of a vault in memory: a value held, handed out as
 * given, replaced whole under the runtime's lock.
 */
class MemoryKeystore implements KeystoreAccess {
  private wrapped: WrappedSeed | null;

  constructor(
    wrapped: WrappedSeed | undefined,
    private readonly locked: <T>(op: () => Promise<T>) => Promise<T>
  ) {
    this.wrapped = wrapped === undefined ? null : checkWrappedSeed(wrapped);
  }

  async read(): Promise<WrappedSeed> {
    if (this.wrapped === null) throw new NotAVault("this vault in memory was given no wrapped seed");
    return this.wrapped;
  }

  async rewrap(next: WrappedSeed): Promise<void> {
    const clean = checkWrappedSeed(next); // checked before the lock is asked for
    await this.locked(async () => {
      this.wrapped = clean;
    });
  }
}

/**
 * The vault as maps in memory: `MemoryEventStore` and `MemoryObjectStore`
 * under one runtime and one lock. Nothing persists, so the process-durable
 * half of the store's promise is vacuous; the boundaries are not: a
 * commit's objects are verified in a preparation no read sees and
 * published in the one synchronous step that accepts its events, so the
 * two land together or not at all; a paused stream blocks no writer;
 * collection waits for the commit in flight, computes its keep set
 * only once it has the lock, and a commit issued meanwhile lands after
 * it has deleted.
 */
export class MemoryVault extends Runtime {
  declare readonly stores: Stores & { events: MemoryEventStore; objects: MemoryObjectStore };

  constructor(options: MemoryVaultOptions) {
    const now = options.now === undefined ? {} : { now: options.now };
    const events = new MemoryEventStore({ ...now, ...(options.author === undefined ? {} : { author: options.author }) });
    const objects = new MemoryObjectStore({
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.extentBytes === undefined ? {} : { extentBytes: options.extentBytes }),
    });
    super({
      author: events.author,
      generation: events.generation,
      metadata: options.metadata,
      stores: {
        events,
        objects,
        transaction: async (body) => {
          const prepared = objects.prepare();
          const drafts = await body(prepared);
          return events.appendAll(drafts, () => prepared.publish());
        },
      },
      keystore: (runtime) => new MemoryKeystore(options.wrapped, (op) => runtime.locked(() => op())),
    });
  }
}
