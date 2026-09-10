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

import { MissingRoot, NotAVault, ObjectTooLarge, UnreferencedObject } from "./errors.js";
import { canonicalEvent, validateDraft, type AuthorId, type Cid, type Draft, type Event, type EventStore, type Ingested, type Rejected } from "./event.js";
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
 * taken cannot be handed in, which is the rule made a type. The object
 * store checks each CID.
 */
export type KeepUnderLock = (held: Held) => Promise<Iterable<Cid>> | Iterable<Cid>;

/**
 * The vault as an operation holding the writer lock sees it: the same
 * interface, every call sharing the held lock instead of taking it — a
 * read nested inside a commit, an import or an export neither waits for
 * itself nor shortens the operation's boundary — plus the primitives
 * the runtime keeps from application code.
 */
export interface Held extends Vault {
  /** The store's `ingest`, for validated import and restore. */
  ingest(events: AsyncIterable<unknown> | Iterable<unknown>): Promise<Ingested>;
  /** One collection pass: `keep` is called here, under the lock, then the unkept are deleted. */
  collect(keep: KeepUnderLock): Promise<Collected>;
  /** Run `op` under the lock already held: nested, shares it. */
  locked<T>(op: (held: Held) => Promise<T>): Promise<T>;
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
 * The vault-wide writer lock for one runtime in one process: operations
 * run one at a time in the order they arrived, each holding it from its
 * first step to its last, whatever it awaits meanwhile. Nesting is not
 * this class's: an operation that needs the lock it already holds works
 * through `Held`.
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

/** What each read that takes no lock asks first: nothing, or a throw refusing it. */
type Check = () => void;

/**
 * One view of the stores: the facade application code gets, when
 * `enter` takes the lock, or the view an operation works through while
 * holding it, when `enter` is immediate. Reads of events and of object
 * metadata take no lock; `open` takes it for the presence check and
 * releases it before the stream is consumed; `read` is `open` drained
 * outside the lock, refused before allocation when the object is larger
 * than `maxBytes`; every mutation runs under it whole.
 */
class View implements Vault {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;

  constructor(
    protected readonly stores: Stores,
    readonly metadata: VaultMetadata,
    protected readonly enter: Enter,
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
    return this.enter(async () => {
      // The batch is fixed first — the drafts validated into copies,
      // the object descriptors copied — so what is checked is what is
      // read: a source that grows the caller's array or rewrites a
      // later descriptor while it streams changes nothing here. Every
      // draft and every CID is checked, and every supplied object
      // matched to a root, before a byte is read: a bad batch accepts nothing.
      const clean = drafts.map((draft) => validateDraft(draft));
      const batch = objects.map(({ cid, source }) => ({ cid, source }));
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

/**
 * The view an operation works through while it holds the lock: the
 * vault's members entering nothing, plus the runtime's primitives. One
 * per runtime; handed to every locked operation and every keep
 * computation.
 */
class HeldView extends View implements Held {
  constructor(stores: Stores, metadata: VaultMetadata) {
    super(stores, metadata, (op) => op());
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
 * The input of `ingest`, read whole before the lock is taken: its
 * validation is its own, and a slow source should not hold the vault.
 * Each input is fixed — validated and copied into canonical form, or
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
  private readonly held: HeldView;
  private readonly guard: (when: "enter" | "run" | "read") => void;

  constructor(options: RuntimeOptions) {
    if (typeof options.stores.transaction !== "function") throw new TypeError("a runtime's stores publish a commit in one transaction: `transaction` is missing");
    this.author = options.author;
    this.generation = options.generation;
    this.metadata = checkMetadata(options.metadata);
    this.stores = options.stores;
    this.guard = options.guard ?? (() => undefined);
    this.held = new HeldView(this.stores, this.metadata);
    this.vault = new View(
      this.stores,
      this.metadata,
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
    return this.enter(() => op(this.held));
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
 * collection waits for the commit in flight and computes its keep set
 * only once it has the lock.
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
