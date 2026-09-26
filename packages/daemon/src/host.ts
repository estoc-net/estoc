import type { OpenMode, SqliteDriver } from "@estoc/event-store";
import type { AgentOptions, DidcommApi } from "@estoc/agent-core";
import type { SeedKey } from "@estoc/keystore";

/** The vault's own database among the host's files. */
export const VAULT_FILE = "vault.sqlite";

/**
 * The SQLite files of one daemon, by name: the vault's runtime, and
 * for the length of an export, a restore or a merge, the portable
 * snapshot beside it. Whoever has this has all of them, from
 * `DaemonHost.storage()` to `close()`: no other daemon makes, opens or
 * removes a file here meanwhile, which is what lets a file be removed
 * once its connection has closed with nobody taking it in between. An
 * open takes the file and refuses a second one with `DatabaseBusy`
 * until it closes. A snapshot crosses the host's boundary as the bytes
 * of its file.
 */
export interface DaemonStorage {
  has(name: string): Promise<boolean>;
  /** `runtime` and `portable` differ in the journal a created file is left in; an existing file keeps its own. */
  open(name: string, mode: OpenMode, kind: "runtime" | "portable"): Promise<SqliteDriver>;
  /** The complete bytes of the file `name`, which no connection may hold open. */
  exportFile(name: string): Promise<Uint8Array>;
  /** Puts a complete database file among the host's as `name`, which must not exist yet. Nothing of it is trusted until it is opened and validated. */
  importFile(name: string, bytes: Uint8Array): Promise<void>;
  /** Deletes `name`, which no connection may hold open, with whatever SQLite kept beside it; nothing when there is none. */
  remove(name: string): Promise<void>;
  /** Lets go of the files as a whole, every connection to them closed first; another daemon may take them from here. */
  close(): Promise<void>;
}

/**
 * What a place the daemon runs in has to provide: where the SQLite
 * files are, where the unlocked seed waits between sessions, the
 * DIDComm library as that runtime loads it, and the transports. A Node
 * process answers with a folder, memory, `@estoc/didcomm-node` and the
 * global fetch; a browser worker with the access-handle pool, IndexedDB
 * and the bundled WASM.
 */
export interface DaemonHost {
  /** The files taken as a whole, until the storage is closed; `DatabaseBusy` while another daemon has them. */
  storage(): Promise<DaemonStorage>;
  /** What stands where the vault would be and is no vault of this version, in words for the person; null when nothing does. Asked before the files are taken, and nothing is taken or written where it answers. */
  foreign?(): Promise<string | null>;
  cachedSeedKey(): Promise<SeedKey | null>;
  cacheSeedKey(key: SeedKey): Promise<void>;
  forgetSeedKey(): Promise<void>;
  didcomm(): Promise<DidcommApi>;
  /** Called when the network comes back, if the host can tell. */
  onOnline?(callback: () => void): void;
  agentOptions?: Pick<AgentOptions, "fetch" | "WebSocket" | "timeoutMs" | "retry">;
}
