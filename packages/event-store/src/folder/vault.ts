/**
 * A vault over a folder (event-store.md §9, vault-folder.md §3): its own
 * three stores, a store per extension, `dispose`, and this copy's local
 * state. Opening checks `config.json` (§11), settles which device this
 * copy is (§7) and announces it (`device.minted`) — the one event type
 * the folder knows the name of, because the format says the folder
 * writes it.
 */

import type { VaultBackend } from "../backend/types.js";
import { walk } from "../backend/types.js";
import { isCid } from "../cid.js";
import { DEFAULT_GRACE_MS } from "../blobs.js";
import { Disposed, NotAVault } from "../errors.js";
import { isDeviceId, mintDeviceId, mintInstance } from "../event.js";
import { isJsonObject, type JsonObject } from "../json.js";
import type { Stores, Vault } from "../vault.js";
import type { FolderBlobStore } from "./blobs.js";
import type { FolderEventStore } from "./events.js";
import { FolderFileStore } from "./files.js";
import { FORMAT, VERSION, parseJson, readConfig } from "./config.js";
import { BLOBS_DIR, CONFIG_FILE, DEVICES_DIR, ESTOC_DIR, EXTENSIONS_DIR, LOCAL_DIR, SELF_FILE, isExtId, isSegmentName, prettyJson } from "./layout.js";
import { LocalOwner, type FolderLocalEventStoreOptions } from "./local.js";
import type { Serial } from "./serial.js";
import { folderStore } from "./store.js";

/** An extension's own store (event-store.md §8), and its local state (§7). */
export interface ExtensionStore extends Stores {
  local: LocalOwner;
}

/** The first event a device writes (vault-events.md §5); the folder appends it on open (vault-folder.md §7). */
export const DEVICE_MINTED = "device.minted";

export interface OpenVaultOptions {
  clock?: () => Date;
  /** how old an unreferenced block must be before `collect` takes it (event-store.md §5.3) */
  graceMs?: number;
  /** how trace streams rotate their segments */
  trace?: FolderLocalEventStoreOptions["rotate"];
}

/** `local/self.json`: which device this copy writes as, and which instance it is (vault-folder.md §7). */
interface Self {
  dev: string;
  instance: string;
}

const RESERVED_OWNERS = new Set([SELF_FILE, EXTENSIONS_DIR, "damaged"]);

export class FolderVault implements Vault {
  readonly events: FolderEventStore;
  readonly blobs: FolderBlobStore;
  readonly files: FolderFileStore;
  private readonly exts = new Map<string, { store: ExtensionStore; serial: Serial }>();
  /** every ext `dispose` was called for: `extension(ext)` and every handle refuse from that moment */
  private readonly disposed = new Set<string>();
  /** every ext whose removal has run: what was queued on the store before `dispose` has finished by then */
  private readonly dead = new Set<string>();
  private readonly owners = new Map<string, LocalOwner>();

  private constructor(
    private readonly backend: VaultBackend,
    readonly self: string,
    readonly instance: string,
    private readonly options: OpenVaultOptions
  ) {
    const none = (): void => undefined;
    const { events, blobs } = this.store(ESTOC_DIR, `${ESTOC_DIR}/${LOCAL_DIR}/damaged/${BLOBS_DIR}`, "vault", none, none);
    this.events = events;
    this.blobs = blobs;
    this.files = new FolderFileStore(backend, ESTOC_DIR);
  }

  private store(base: string, aside: string, store: string, guard: () => void, alive: () => void): { events: FolderEventStore; blobs: FolderBlobStore; serial: Serial } {
    const options = { base, aside, self: this.self, instance: this.instance, store, guard, alive, graceMs: this.options.graceMs ?? DEFAULT_GRACE_MS };
    return folderStore(this.backend, this.options.clock === undefined ? options : { ...options, clock: this.options.clock });
  }

  /**
   * Open the vault in `backend`: refuse anything but a version-2
   * `config.json` (vault-folder.md §11), read or mint `local/self.json`
   * (§7), and append `device.minted` if this device has none yet.
   */
  static async open(backend: VaultBackend, options: OpenVaultOptions = {}): Promise<FolderVault> {
    const config = await backend.read(`${ESTOC_DIR}/${CONFIG_FILE}`);
    if (config === null) {
      throw new NotAVault(`no ${ESTOC_DIR}/${CONFIG_FILE}`);
    }
    readConfig(config);
    const self = await readSelf(backend);
    const vault = new FolderVault(backend, self.dev, self.instance, options);
    await vault.announce();
    return vault;
  }

  /**
   * Make a vault in an empty backend and open it: `config.json` is
   * `{ format, version }` plus what the caller fixes for the vault's
   * life (its anchor), written first, once.
   */
  static async create(backend: VaultBackend, config: JsonObject, options: OpenVaultOptions = {}): Promise<FolderVault> {
    const path = `${ESTOC_DIR}/${CONFIG_FILE}`;
    if ((await backend.size(path)) !== null) {
      throw new NotAVault(`${path} exists already`);
    }
    if ("format" in config || "version" in config) {
      throw new NotAVault("format and version are the folder's to write");
    }
    await backend.write(path, prettyJson({ format: FORMAT, version: VERSION, ...config }));
    return FolderVault.open(backend, options);
  }

  /** On every open (§7): a `device.minted` under `devices/<self>/`, or append one. */
  private async announce(): Promise<void> {
    for await (const _ of this.events.scan({ author: this.self, type: DEVICE_MINTED })) {
      return;
    }
    await this.events.append({ type: DEVICE_MINTED, data: {} });
  }

  // ---- extensions --------------------------------------------------------

  extension(ext: string): ExtensionStore {
    if (!isExtId(ext)) {
      throw new Error(`not an extension id: ${ext}`);
    }
    if (this.disposed.has(ext)) {
      throw new Disposed(ext);
    }
    let have = this.exts.get(ext);
    if (have === undefined) {
      const base = `${ESTOC_DIR}/${EXTENSIONS_DIR}/${ext}`;
      const localDir = `${ESTOC_DIR}/${LOCAL_DIR}/${EXTENSIONS_DIR}/${ext}`;
      const guard = (): void => {
        if (this.disposed.has(ext)) {
          throw new Disposed(ext);
        }
      };
      const alive = (): void => {
        if (this.dead.has(ext)) {
          throw new Disposed(ext);
        }
      };
      const { events, blobs, serial } = this.store(base, `${localDir}/damaged/${BLOBS_DIR}`, ext, guard, alive);
      have = { serial, store: { events, blobs, local: new LocalOwner(this.backend, localDir, { ...this.localOptions(), alive }, guard) } };
      this.exts.set(ext, have);
    }
    return have.store;
  }

  async extensions(): Promise<string[]> {
    const dir = `${ESTOC_DIR}/${EXTENSIONS_DIR}`;
    const found: string[] = [];
    for (const ext of (await this.backend.dirs(dir)).filter(isExtId).sort()) {
      if (await hasBytes(this.backend, `${dir}/${ext}`)) {
        found.push(ext);
      }
    }
    return found;
  }

  /**
   * Remove every file under `extensions/<ext>/` and `local/extensions/<ext>/`
   * (vault-folder.md §3.1) after the operations in flight on that store
   * and before any can begin; every handle is dead from the call on.
   */
  async dispose(ext: string): Promise<void> {
    if (!isExtId(ext)) {
      throw new Error(`not an extension id: ${ext}`);
    }
    const have = this.exts.get(ext);
    this.disposed.add(ext);
    const remove = async (): Promise<void> => {
      await have?.store.local.settle();
      this.dead.add(ext);
      for (const dir of [`${ESTOC_DIR}/${EXTENSIONS_DIR}/${ext}`, `${ESTOC_DIR}/${LOCAL_DIR}/${EXTENSIONS_DIR}/${ext}`]) {
        for (const path of await walk(this.backend, dir)) {
          await this.backend.remove(path);
        }
      }
    };
    if (have === undefined) {
      await remove();
    } else {
      await have.serial.run(remove);
    }
  }

  // ---- local -------------------------------------------------------------

  private localOptions(): FolderLocalEventStoreOptions {
    const options: FolderLocalEventStoreOptions = {};
    if (this.options.clock !== undefined) {
      options.clock = this.options.clock;
    }
    if (this.options.trace !== undefined) {
      options.rotate = this.options.trace;
    }
    return options;
  }

  /** A named owner's local state under `local/<owner>/` (vault-folder.md §7): `agent`, or the application's own name. */
  local(owner: string): LocalOwner {
    if (!/^[a-z][a-z0-9-]*$/.test(owner) || RESERVED_OWNERS.has(owner)) {
      throw new Error(`not a local owner name: ${owner}`);
    }
    let have = this.owners.get(owner);
    if (have === undefined) {
      have = new LocalOwner(this.backend, `${ESTOC_DIR}/${LOCAL_DIR}/${owner}`, this.localOptions());
      this.owners.set(owner, have);
    }
    return have;
  }
}

/** `local/self.json`, or mint one (vault-folder.md §7): the first open on this copy. */
async function readSelf(backend: VaultBackend): Promise<Self> {
  const path = `${ESTOC_DIR}/${LOCAL_DIR}/${SELF_FILE}`;
  const bytes = await backend.read(path);
  if (bytes !== null) {
    const parsed = parseJson(bytes, SELF_FILE);
    if (!isJsonObject(parsed) || !isDeviceId(parsed["dev"]) || typeof parsed["instance"] !== "string" || parsed["instance"] === "") {
      throw new NotAVault(`${path} is not { dev, instance }`);
    }
    return { dev: parsed["dev"], instance: parsed["instance"] };
  }
  const self: Self = { dev: mintDeviceId(), instance: mintInstance() };
  await backend.write(path, prettyJson(self));
  return self;
}

/** Whether an extension's directory holds a segment or a block (vault-folder.md §3.1): a store, not nothing. */
async function hasBytes(backend: VaultBackend, dir: string): Promise<boolean> {
  for (const dev of (await backend.dirs(`${dir}/${DEVICES_DIR}`)).filter(isDeviceId)) {
    if ((await backend.list(`${dir}/${DEVICES_DIR}/${dev}`)).some(isSegmentName)) {
      return true;
    }
  }
  return (await backend.list(`${dir}/${BLOBS_DIR}`)).some(isCid);
}
