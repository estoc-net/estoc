/**
 * The vault over a folder, version 3: the three folder stores under one
 * runtime, one writer lock and one latch registry, opened for writing or
 * for reading.
 *
 * A read-only open validates the path shape, `config.json` and the
 * structural roots, creates no `local/` and alters no `import/`; it
 * takes no ownership unless asked, and without ownership it serves no
 * object stream (unprotected reads are refused, not served); its
 * object store moves nothing, so a file found not to spell its name is
 * reported and dropped from the reader's view, never quarantined. A
 * writable open additionally validates `keystore.json` by shape,
 * compares the anchor the caller derived from the unlocked seed with
 * the one `config.json` fixes, takes writer-exclusive ownership through
 * the backend before creating any local state, finishes or rolls back
 * whatever import `import/` records — and refuses over one it does not
 * understand — then reads or mints `local/replica.json` and
 * opens the event store as that replica. `close`
 * refuses every new operation, lets the accepted ones run out, fails
 * the object streams still alive, and only then releases ownership;
 * `halt` refuses the accepted ones too, queued operations and reads
 * alike, for a runtime that must not go on reading the folder.
 *
 * Unlocking the seed is not this module's: the caller hands in the
 * anchor DID it derived (`@estoc/keystore`, under the fixed name). This
 * package knows no key.
 */

import type { Ownership, VaultBackend } from "../../backend/types.js";
import { AnchorMismatch, NotAVault, ReadOnlyVault, Unprotected, VaultClosed } from "../errors.js";
import type { Cid, Damaged } from "../event.js";
import { comparePaths, type FileStore } from "../files.js";
import { LatchRegistry } from "../objects.js";
import { Runtime, type VaultEvents, type VaultObjects } from "../vault.js";
import { encodeConfig, parseConfig, type Config } from "./config.js";
import { FolderEventStore, type FolderEventStoreOptions } from "./events.js";
import { FolderFileStore } from "./files.js";
import { checkImport, recoverImports } from "./import.js";
import { checkKeystore } from "./keystore.js";
import { CONFIG_FILE, ESTOC_DIR, KEYSTORE_FILE, LOCAL_DIR } from "./layout.js";
import { LocalOwner, type LocalOptions, type Rotation } from "./local.js";
import { FolderObjectStore, type FolderObjectStoreOptions } from "./objects.js";
import { mintReplica, openReplica, type Replica } from "./replica.js";
import { OWNER_FILE, checkEmpty, checkRoots, layoutDamage, readConfig } from "./roots.js";

export interface FolderVaultOptions {
  /** the layout's directory, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the wall clock in Unix milliseconds, for `at`, orphan age and trace rotation; default `Date.now`, pinned by tests together with the backend's clock */
  now?: () => number;
  /** the least age since acceptance an object no event keeps must have before `collect` removes it; default one hour */
  graceMs?: number;
  /** the largest object a commit accepts; default 1 GiB */
  maxObjectBytes?: number;
  /** rotate the append segment once it is this long; default `ROTATE_BYTES` */
  rotateBytes?: number;
  /** how trace streams rotate their segments */
  trace?: Rotation;
}

export interface OpenWritableOptions extends FolderVaultOptions {
  /** the DID the unlocked seed derives under the fixed anchor name: compared with `config.json`'s before anything else happens */
  anchor: string;
  /** the replica identity to mint when `local/replica.json` is absent; the standard generator when left out */
  mint?: () => Replica;
}

export interface CreateOptions extends OpenWritableOptions {
  /** `keystore.json` as `@estoc/keystore` serialized it: checked by shape, written first */
  keystore: Uint8Array;
}

export interface OpenReadOnlyOptions extends FolderVaultOptions {
  /**
   * `"exclusive"`: take the same ownership a writer would — there is
   * no shared advisory lock, only the one exclusive ownership — so object
   * streams are protected and a writer waits or fails meanwhile; makes
   * the owner file under `local/`. `"none"`, the default: touch nothing, and
   * refuse object streams as unprotected.
   */
  ownership?: "exclusive" | "none";
}

function eventOptions(options: FolderVaultOptions, base: string): FolderEventStoreOptions {
  return {
    base,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.rotateBytes === undefined ? {} : { rotateBytes: options.rotateBytes }),
  };
}

function objectOptions(options: FolderVaultOptions, base: string, latches: LatchRegistry): FolderObjectStoreOptions {
  return {
    base,
    latches,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
    ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
  };
}

function localOptions(options: FolderVaultOptions): LocalOptions {
  return {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.trace === undefined ? {} : { rotate: options.trace }),
  };
}

const OWNER_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The writable vault over a folder: a `Runtime` over the three folder
 * stores, opened as this copy's replica, holding the folder's
 * ownership until `close`.
 */
export class FolderVault extends Runtime {
  declare readonly stores: { events: FolderEventStore; objects: FolderObjectStore; files: FolderFileStore };
  /** the read latches over this vault's objects */
  readonly latches: LatchRegistry;
  private readonly owners = new Map<string, LocalOwner>();

  /**
   * `state` is shared with the runtime's guard and the event store's,
   * both made before `super` returns and so unable to read a field of
   * `this`. `closed` is set by `close`: nothing new is accepted, what
   * was runs out. `halted` is set by `halt`: nothing runs, accepted
   * or not.
   */
  private constructor(
    /** the bytes under the vault: what `importFolder` stages its barrier in */
    readonly backend: VaultBackend,
    readonly base: string,
    readonly config: Config,
    readonly replica: Replica,
    private readonly ownership: Ownership,
    private readonly options: FolderVaultOptions,
    private readonly state: State,
    latches: LatchRegistry,
    stores: { events: FolderEventStore; objects: FolderObjectStore; files: FolderFileStore }
  ) {
    super(replica.replica_id, replica.store_generation, stores, (when) => {
      if (state.halted || (when === "enter" && state.closed)) throw new VaultClosed();
    });
    this.latches = latches;
  }

  /**
   * A writable open: `config.json`, `keystore.json` by shape,
   * the anchor compared, ownership taken, the import `import/` records
   * finished or rolled back, the replica read or minted, the stores
   * opened as it — in that order, each step before the next touches
   * anything, and ownership released on any failure after it was taken.
   */
  static async openWritable(backend: VaultBackend, options: OpenWritableOptions): Promise<FolderVault> {
    const base = options.base ?? ESTOC_DIR;
    const config = await FolderVault.preflight(backend, base, options.anchor);
    const ownership = await backend.own(`${base}/${OWNER_FILE}`);
    return FolderVault.openOwned(backend, base, config, ownership, options);
  }

  /**
   * Lay down a new vault in an empty folder and open it: the keystore
   * and the anchor checked — the anchor by the same parser an open uses
   * — before anything is taken or written; the folder required
   * empty of everything but ownership's own files, before and again
   * after ownership is taken: an existing `keystore.json`, a
   * segment, an object, recovery state under `import/`, an opaque file
   * or leftover `local/` state is refused with every byte left as it
   * was — a folder that holds a seed wrapper is not one to lay a new
   * vault over, and a partial vault is recovered or cleared on purpose,
   * never overwritten by the next create. Ownership taken first excludes
   * a second create rather than detecting it. Then `keystore.json`, then
   * `config.json`, which is what makes it a vault; a crash between the
   * two leaves no vault rather than a headless one. Every step after
   * ownership releases it on failure.
   */
  static async create(backend: VaultBackend, options: CreateOptions): Promise<FolderVault> {
    const base = options.base ?? ESTOC_DIR;
    checkKeystore(options.keystore, KEYSTORE_FILE);
    if (typeof options.anchor !== "string") throw new NotAVault("anchor is not a did:key");
    const bytes = encodeConfig(options.anchor);
    const config = parseConfig(bytes, CONFIG_FILE);
    await checkRoots(backend, base);
    await checkEmpty(backend, base);
    const ownership = await backend.own(`${base}/${OWNER_FILE}`);
    try {
      await checkEmpty(backend, base);
      await backend.write(`${base}/${KEYSTORE_FILE}`, options.keystore);
      await backend.write(`${base}/${CONFIG_FILE}`, bytes);
    } catch (err) {
      await ownership.release();
      throw err;
    }
    return FolderVault.openOwned(backend, base, config, ownership, options);
  }

  /** What a writable open checks before taking anything: the path shape, `config.json`, `keystore.json`, the anchor, and the shape of the roots — nothing taken, nothing written. */
  private static async preflight(backend: VaultBackend, base: string, anchor: string): Promise<Config> {
    const config = await readConfig(backend, base);
    const keystore = await backend.read(`${base}/${KEYSTORE_FILE}`);
    if (keystore === null) throw new NotAVault(`no ${base}/${KEYSTORE_FILE}: a writable open needs the seed's wrapper`);
    checkKeystore(keystore, KEYSTORE_FILE);
    if (config.identity.anchor.did !== anchor) throw new AnchorMismatch(config.identity.anchor.did, anchor);
    await checkRoots(backend, base);
    return config;
  }

  /**
   * What a writable open does once it holds ownership: the import
   * recorded under `import/` finished or rolled back — before the
   * replica is read and before any store opens, so that nothing of this
   * runtime, collection included, sees a partial union — then the
   * replica, then the stores; ownership released on a failure.
   */
  private static async openOwned(backend: VaultBackend, base: string, config: Config, ownership: Ownership, options: OpenWritableOptions): Promise<FolderVault> {
    try {
      await recoverImports(backend, base);
      const replica = await openReplica(backend, base, options.mint ?? mintReplica);
      const latches = new LatchRegistry();
      const state: State = { closed: false, halted: false };
      const stores = {
        events: new FolderEventStore(backend, replica, {
          ...eventOptions(options, base),
          guard: () => {
            if (state.halted) throw new VaultClosed();
          },
        }),
        objects: new FolderObjectStore(backend, objectOptions(options, base, latches)),
        files: new FolderFileStore(backend, base),
      };
      return new FolderVault(backend, base, config, replica, ownership, options, state, latches, stores);
    } catch (err) {
      await ownership.release();
      throw err;
    }
  }

  /** A named owner's local state under `local/<owner>/`: `agent` for the application. */
  local(owner: string): LocalOwner {
    if (!OWNER_NAME.test(owner)) throw new Error(`not a local owner name: ${owner}`);
    if (this.state.closed) throw new VaultClosed();
    let have = this.owners.get(owner);
    if (have === undefined) {
      have = new LocalOwner(this.backend, `${this.base}/${LOCAL_DIR}/${owner}`, {
        ...localOptions(this.options),
        guard: () => {
          if (this.state.closed) throw new VaultClosed();
        },
      });
      this.owners.set(owner, have);
    }
    return have;
  }

  /** What the folder holds that the layout does not define: from the roots, `events/` and `objects/`, in path order. */
  async damaged(): Promise<Damaged[]> {
    const found = [...(await layoutDamage(this.backend, this.base)), ...(await this.stores.events.damaged()), ...(await this.stores.objects.damaged())];
    return found.sort((a, b) => comparePaths(a.where, b.where));
  }

  /** Is this vault still open? */
  get open(): boolean {
    return !this.state.closed;
  }

  /**
   * Release the folder: new operations are refused from this call
   * on — the runtime's, and every local owner's, cache's and trace
   * handle's — then what was already accepted runs out: the
   * operations holding or queued for the writer lock, the local work
   * queued on each owner; then every object stream still alive is
   * failed with `VaultClosed` and its latch released, and no stream
   * opens after; and only then is ownership released, so that
   * nothing of this runtime still reads or writes a folder another
   * process may own by then. Once; a second close does nothing.
   */
  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    await this.lock.run(async () => undefined);
    await Promise.all([...this.owners.values()].map((owner) => owner.settle()));
    await this.stores.objects.close();
    await this.ownership.release();
  }

  /**
   * Stop where it stands, then close: from this call on every
   * operation queued for the writer lock is refused as it would take
   * it, every read that takes no lock is refused as it is asked, and
   * every new operation as `close` refuses it; then the vault closes as
   * `close` closes it, ownership released last. For an import that
   * could not finish once its journal was written: `events/` may hold
   * the union half published, which only the next writable open's
   * recovery completes, and nothing of this runtime — a collection or
   * a fold already waiting for the lock included — may read it as the
   * vault meanwhile.
   */
  async halt(): Promise<void> {
    this.state.halted = true;
    await this.close();
  }
}

interface State {
  closed: boolean;
  halted: boolean;
}

/**
 * A vault opened read-only: events, objects and files to read,
 * the config, and what is damaged. No `local/` is created, no
 * `import/` altered, nothing written; `files.write` is refused. Object
 * streams are served only with ownership.
 */
export class FolderReader {
  readonly events: VaultEvents;
  readonly objects: VaultObjects;
  readonly files: FileStore;
  private closed = false;

  private constructor(
    private readonly backend: VaultBackend,
    readonly base: string,
    readonly config: Config,
    private readonly ownership: Ownership | null,
    readonly stores: { events: FolderEventStore; objects: FolderObjectStore; files: FolderFileStore }
  ) {
    const guard = (): void => {
      if (this.closed) throw new VaultClosed();
    };
    const protect = (cid: Cid): void => {
      guard();
      if (this.ownership === null) throw new Unprotected(cid);
    };
    const { events, objects, files } = stores;
    // A reader without ownership shares the folder with a live writer,
    // whose import publishes segments one by one: a read of `events/`
    // stands only when nothing was under `import/` before it began and
    // after it ended, an import's directory being there from its first
    // staged byte to its last rename.
    const published = async <T>(read: () => Promise<T>): Promise<T> => {
      guard();
      await checkImport(backend, base);
      const out = await read();
      await checkImport(backend, base);
      return out;
    };
    // Every refusal is a rejection — of the promise, or of the iteration's first step — as every other failure is.
    this.events = {
      scan: async function* (filter) {
        yield* (await published(() => events.changes(filter))).events;
      },
      changes: (filter, since) => published(() => events.changes(filter, since)),
      damaged: () => published(() => events.damaged()),
      conflicting: () => published(() => events.conflicting()),
    };
    this.objects = {
      open: async (cid) => {
        protect(cid);
        return objects.open(cid);
      },
      read: async (cid, maxBytes) => {
        protect(cid);
        return objects.read(cid, maxBytes);
      },
      stat: (cid) => objects.stat(cid),
      has: (cid) => objects.has(cid),
      list: () => objects.list(),
    };
    this.files = {
      read: (path) => files.read(path),
      write: async (path) => {
        throw new ReadOnlyVault(`write ${path}`);
      },
      list: () => files.list(),
    };
  }

  /**
   * A read-only open: the path shape and `config.json` checked,
   * the roots looked at, `import/` required empty — recovery state
   * there is reported, never read around — and ownership taken only
   * when asked. The event store reads as no replica: it is never
   * appended to. Nothing under `local/` is created or read.
   */
  static async open(backend: VaultBackend, options: OpenReadOnlyOptions = {}): Promise<FolderReader> {
    const base = options.base ?? ESTOC_DIR;
    const config = await readConfig(backend, base);
    await checkRoots(backend, base);
    await checkImport(backend, base);
    const ownership = options.ownership === "exclusive" ? await backend.own(`${base}/${OWNER_FILE}`) : null;
    try {
      // A replica no event carries: the store never writes here, and a reader has no author.
      const nobody = mintReplica();
      const latches = new LatchRegistry();
      const stores = {
        events: new FolderEventStore(backend, nobody, eventOptions(options, base)),
        objects: new FolderObjectStore(backend, { ...objectOptions(options, base, latches), readOnly: true }),
        files: new FolderFileStore(backend, base),
      };
      return new FolderReader(backend, base, config, ownership, stores);
    } catch (err) {
      await ownership?.release();
      throw err;
    }
  }

  /** Whether this reader holds the folder's ownership: with it, object streams are protected. */
  get owned(): boolean {
    return this.ownership !== null;
  }

  /** What the folder holds that the layout does not define, in path order. */
  async damaged(): Promise<Damaged[]> {
    const found = [...(await layoutDamage(this.backend, this.base)), ...(await this.events.damaged()), ...(await this.stores.objects.damaged())];
    return found.sort((a, b) => comparePaths(a.where, b.where));
  }

  /** Reads after this are refused; every object stream still alive is failed and no more open; then ownership, if any, is released. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stores.objects.close();
    if (this.ownership !== null) await this.ownership.release();
  }
}
