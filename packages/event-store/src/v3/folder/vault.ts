/**
 * The vault over a folder, version 3 (vault-folder.md §11.1, §15,
 * event-store.md §10): the three folder stores under one runtime, one
 * writer lock and one latch registry, opened for writing or for reading.
 *
 * A read-only open validates the path shape, `config.json` and the
 * structural roots, creates no `local/` and alters no `import/`; it
 * takes no ownership unless asked, and without ownership it serves no
 * object stream (§15: unprotected reads are refused, not served). A
 * writable open additionally validates `keystore.json` by shape,
 * compares the anchor the caller derived from the unlocked seed with
 * the one `config.json` fixes, takes writer-exclusive ownership through
 * the backend before creating any local state, refuses while `import/`
 * holds recovery state, then reads or mints `local/replica.json` and
 * opens the event store as that replica (§11.1 steps 1–6). `close`
 * releases ownership; every operation after it is refused.
 *
 * Unlocking the seed is not this module's: the caller hands in the
 * anchor DID it derived (`@estoc/keystore`, under the fixed name). This
 * package knows no key.
 */

import type { Ownership, VaultBackend } from "../../backend/types.js";
import { walk } from "../../backend/types.js";
import { AnchorMismatch, DamagedLayout, NotAVault, PendingImport, ReadOnlyVault, Unprotected, VaultClosed } from "../errors.js";
import type { Cid, Damaged } from "../event.js";
import { comparePaths, type FileStore } from "../files.js";
import { LatchRegistry } from "../objects.js";
import { Runtime, type VaultEvents, type VaultObjects } from "../vault.js";
import { encodeConfig, parseConfig, type Config } from "./config.js";
import { FolderEventStore, type FolderEventStoreOptions } from "./events.js";
import { FolderFileStore } from "./files.js";
import { checkKeystore } from "./keystore.js";
import { CONFIG_FILE, ESTOC_DIR, IMPORT_DIR, KEYSTORE_FILE, LOCAL_DIR, kindOf } from "./layout.js";
import { LocalOwner, type LocalOptions, type Rotation } from "./local.js";
import { FolderObjectStore, type FolderObjectStoreOptions } from "./objects.js";
import { mintReplica, openReplica, type Replica } from "./replica.js";

/** Where ownership is named (§15): under `local/`, this copy's own; on disk, the writer's pid file. */
export const OWNER_FILE = `${LOCAL_DIR}/owner.pid`;

export interface FolderVaultOptions {
  /** the layout's directory, relative to the backend's root; `.estoc` when left out */
  base?: string;
  /** the wall clock in Unix milliseconds, for `at`, orphan age and trace rotation; default `Date.now`, pinned by tests together with the backend's clock */
  now?: () => number;
  /** orphan grace (dasl-objects.md §8.3); default one hour */
  graceMs?: number;
  /** the largest object a commit accepts (dasl-objects.md §12); default 1 GiB */
  maxObjectBytes?: number;
  /** rotate the append segment once it is this long (§8.1); default `ROTATE_BYTES` */
  rotateBytes?: number;
  /** how trace streams rotate their segments (§10.2) */
  trace?: Rotation;
}

export interface OpenWritableOptions extends FolderVaultOptions {
  /** the DID the unlocked seed derives under the fixed anchor name (§4): compared with `config.json`'s before anything else happens */
  anchor: string;
  /** the replica identity to mint when `local/replica.json` is absent (§10.1); the standard generator when left out */
  mint?: () => Replica;
}

export interface CreateOptions extends OpenWritableOptions {
  /** `keystore.json` as `@estoc/keystore` serialized it: checked by shape (§5), written first */
  keystore: Uint8Array;
}

export interface OpenReadOnlyOptions extends FolderVaultOptions {
  /**
   * `"exclusive"`: take the same ownership a writer would (§15; decision
   * 5 of the v3 plan: no shared advisory lock), so object streams are
   * protected and a writer waits or fails meanwhile — makes the owner
   * file under `local/`. `"none"`, the default: touch nothing, and
   * refuse object streams as unprotected.
   */
  ownership?: "exclusive" | "none";
}

/** What the folder holds that the layout does not define (§3, VF-16), from every root, in path order. */
async function layoutDamage(backend: VaultBackend, base: string): Promise<Damaged[]> {
  const damaged: Damaged[] = [];
  for (const file of [CONFIG_FILE, KEYSTORE_FILE]) {
    const at = `${base}/${file}`;
    if ((await backend.list(at)).length > 0 || (await backend.dirs(at)).length > 0) damaged.push({ where: file, error: `a directory where ${file} belongs` });
  }
  for (const dir of [IMPORT_DIR, LOCAL_DIR]) {
    if ((await backend.size(`${base}/${dir}`)) !== null) damaged.push({ where: dir, error: `a file where the ${dir} directory belongs` });
  }
  return damaged;
}

/** A file where `import/` or `local/` belongs is refused before ownership is taken or anything written (§3). */
async function checkRoots(backend: VaultBackend, base: string): Promise<void> {
  for (const damage of await layoutDamage(backend, base)) {
    if (damage.where === IMPORT_DIR || damage.where === LOCAL_DIR) throw new DamagedLayout(damage.where, damage.error);
  }
}

/** `config.json` read and checked (§11.1 step 2); `NotAVault` when it is not there. */
async function readConfig(backend: VaultBackend, base: string): Promise<Config> {
  const bytes = await backend.read(`${base}/${CONFIG_FILE}`);
  if (bytes === null) throw new NotAVault(`no ${base}/${CONFIG_FILE}: not a vault`);
  return parseConfig(bytes, CONFIG_FILE);
}

/**
 * Whatever stands under `import/` blocks the open (§3, VF-40): this
 * version records no import there yet, so anything found is an import
 * another backend or version left unfinished, or damage — either way
 * not something to open over. An empty or absent `import/` is nothing
 * pending.
 */
async function checkImport(backend: VaultBackend, base: string): Promise<void> {
  const dir = `${base}/${IMPORT_DIR}`;
  const entries = [...(await backend.list(dir)), ...(await backend.dirs(dir))].sort(comparePaths);
  if (entries.length > 0) throw new PendingImport(entries);
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
  /** the read latches over this vault's objects (event-store.md §10) */
  readonly latches: LatchRegistry;
  private readonly owners = new Map<string, LocalOwner>();
  /** set by `close`; read by the runtime's guard, which is made before `super` returns and so cannot read a field of `this` */
  private readonly state: { closed: boolean };

  private constructor(
    private readonly backend: VaultBackend,
    readonly base: string,
    readonly config: Config,
    readonly replica: Replica,
    private readonly ownership: Ownership,
    private readonly options: FolderVaultOptions,
    latches: LatchRegistry,
    stores: { events: FolderEventStore; objects: FolderObjectStore; files: FolderFileStore }
  ) {
    const state = { closed: false };
    super(replica.replica_id, replica.store_generation, stores, () => {
      if (state.closed) throw new VaultClosed();
    });
    this.state = state;
    this.latches = latches;
  }

  /**
   * A writable open (§11.1): `config.json`, `keystore.json` by shape,
   * the anchor compared, ownership taken, `import/` checked, the replica
   * read or minted, the stores opened as it — in that order, each step
   * before the next touches anything, and ownership released on any
   * failure after it was taken.
   */
  static async openWritable(backend: VaultBackend, options: OpenWritableOptions): Promise<FolderVault> {
    const base = options.base ?? ESTOC_DIR;
    const config = await FolderVault.preflight(backend, base, options.anchor);
    const ownership = await backend.own(`${base}/${OWNER_FILE}`);
    return FolderVault.openOwned(backend, base, config, ownership, options);
  }

  /**
   * Lay down a new vault in an empty folder and open it: the keystore
   * checked by shape before anything is written, ownership taken first
   * — so two creates of one folder are excluded, not detected after
   * — then `keystore.json`, then `config.json`, which is what makes it
   * a vault; a crash between the two leaves no vault rather than a
   * headless one. An existing `config.json` is refused before and after
   * ownership.
   */
  static async create(backend: VaultBackend, options: CreateOptions): Promise<FolderVault> {
    const base = options.base ?? ESTOC_DIR;
    checkKeystore(options.keystore, KEYSTORE_FILE);
    if (typeof options.anchor !== "string" || !options.anchor.startsWith("did:key:")) throw new NotAVault("anchor is not a did:key");
    const exists = async (): Promise<void> => {
      if ((await backend.size(`${base}/${CONFIG_FILE}`)) !== null) throw new NotAVault(`${base}/${CONFIG_FILE} exists already`);
    };
    await exists();
    await checkRoots(backend, base);
    const ownership = await backend.own(`${base}/${OWNER_FILE}`);
    try {
      await exists();
      await backend.write(`${base}/${KEYSTORE_FILE}`, options.keystore);
      await backend.write(`${base}/${CONFIG_FILE}`, encodeConfig(options.anchor));
    } catch (err) {
      await ownership.release();
      throw err;
    }
    const config = parseConfig(encodeConfig(options.anchor));
    return FolderVault.openOwned(backend, base, config, ownership, options);
  }

  /** Steps 1–3 of §11.1 for a writable open, and the shape of the roots: nothing taken, nothing written. */
  private static async preflight(backend: VaultBackend, base: string, anchor: string): Promise<Config> {
    const config = await readConfig(backend, base);
    const keystore = await backend.read(`${base}/${KEYSTORE_FILE}`);
    if (keystore === null) throw new NotAVault(`no ${base}/${KEYSTORE_FILE}: a writable open needs the seed's wrapper`);
    checkKeystore(keystore, KEYSTORE_FILE);
    if (config.identity.anchor.did !== anchor) throw new AnchorMismatch(config.identity.anchor.did, anchor);
    await checkRoots(backend, base);
    return config;
  }

  /** Steps 5–6 of §11.1, ownership already held: `import/`, the replica, the stores; ownership released on a failure. */
  private static async openOwned(backend: VaultBackend, base: string, config: Config, ownership: Ownership, options: OpenWritableOptions): Promise<FolderVault> {
    try {
      await checkImport(backend, base);
      const replica = await openReplica(backend, base, options.mint ?? mintReplica);
      const latches = new LatchRegistry();
      const stores = {
        events: new FolderEventStore(backend, replica, eventOptions(options, base)),
        objects: new FolderObjectStore(backend, objectOptions(options, base, latches)),
        files: new FolderFileStore(backend, base),
      };
      return new FolderVault(backend, base, config, replica, ownership, options, latches, stores);
    } catch (err) {
      await ownership.release();
      throw err;
    }
  }

  /** A named owner's local state under `local/<owner>/` (§10.2): `agent` for the application. */
  local(owner: string): LocalOwner {
    if (!OWNER_NAME.test(owner)) throw new Error(`not a local owner name: ${owner}`);
    if (this.state.closed) throw new VaultClosed();
    let have = this.owners.get(owner);
    if (have === undefined) {
      have = new LocalOwner(this.backend, `${this.base}/${LOCAL_DIR}/${owner}`, localOptions(this.options));
      this.owners.set(owner, have);
    }
    return have;
  }

  /** What the folder holds that the layout does not define (§3, VF-16): from the roots, `events/` and `objects/`, in path order. */
  async damaged(): Promise<Damaged[]> {
    const found = [...(await layoutDamage(this.backend, this.base)), ...(await this.stores.events.damaged()), ...(await this.stores.objects.damaged())];
    return found.sort((a, b) => comparePaths(a.where, b.where));
  }

  /** Every portable path (§3.1, §12.1): what a snapshot copies — never `local/` or `import/`. In code-point order. */
  async portablePaths(): Promise<string[]> {
    const prefix = `${this.base}/`;
    return (await walk(this.backend, this.base))
      .map((path) => path.slice(prefix.length))
      .filter((path) => {
        const kind = kindOf(path);
        return kind !== "local" && kind !== "import";
      })
      .sort(comparePaths);
  }

  /** Is this vault still open? */
  get open(): boolean {
    return !this.state.closed;
  }

  /**
   * Release the folder (§15): after the operations already holding the
   * lock have run, and before any queued after this call — which are
   * refused. Ownership is released once; a second close does nothing.
   */
  async close(): Promise<void> {
    if (this.state.closed) return;
    this.state.closed = true;
    await this.lock.run(async () => undefined);
    await this.ownership.release();
  }
}

/**
 * A vault opened read-only (§11.1): events, objects and files to read,
 * the config, and what is damaged. No `local/` is created, no
 * `import/` altered, nothing written; `files.write` is refused. Object
 * streams are served only with ownership (§15).
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
    // Every refusal is a rejection — of the promise, or of the iteration's first step — as every other failure is.
    this.events = {
      scan: async function* (filter) {
        guard();
        yield* events.scan(filter);
      },
      changes: async (filter, since) => {
        guard();
        return events.changes(filter, since);
      },
      damaged: () => events.damaged(),
      conflicting: () => events.conflicting(),
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
   * A read-only open (§11.1): the path shape and `config.json` checked,
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
      // A replica no event carries: the store never writes here, and a reader has no author (§11.1).
      const nobody = mintReplica();
      const latches = new LatchRegistry();
      const stores = {
        events: new FolderEventStore(backend, nobody, eventOptions(options, base)),
        objects: new FolderObjectStore(backend, objectOptions(options, base, latches)),
        files: new FolderFileStore(backend, base),
      };
      return new FolderReader(backend, base, config, ownership, stores);
    } catch (err) {
      await ownership?.release();
      throw err;
    }
  }

  /** Whether this reader holds the folder's ownership (§15): with it, object streams are protected. */
  get owned(): boolean {
    return this.ownership !== null;
  }

  /** What the folder holds that the layout does not define (§3, VF-16), in path order. */
  async damaged(): Promise<Damaged[]> {
    const found = [...(await layoutDamage(this.backend, this.base)), ...(await this.stores.events.damaged()), ...(await this.stores.objects.damaged())];
    return found.sort((a, b) => comparePaths(a.where, b.where));
  }

  /** Release ownership, if any; reads after this are refused. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownership !== null) await this.ownership.release();
  }
}
