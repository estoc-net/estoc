import type { TraceLevel, VaultBackend } from "@estoc/vault";
import type { AgentOptions, DidcommApi } from "@estoc/agent-core";

/**
 * What a place the daemon runs in has to provide: where the bytes are, how
 * one agent per vault is kept, where the unlocked seed waits between
 * sessions, the DIDComm library as that runtime loads it, and the
 * transports. The browser worker answers with OPFS, Web Locks, IndexedDB
 * and the Vite-loaded WASM; a Node process with a folder, a pid file,
 * memory, `didcomm-node` and a fetch that refuses private addresses.
 */
export interface DaemonHost {
  /** Resolve once this daemon may open the vault; `onWaiting` if another holds it meanwhile. */
  lock(onWaiting: () => void): Promise<void>;
  backend(): Promise<VaultBackend>;
  /** Remove the vault outright — "forget this identity". */
  wipe(): Promise<void>;
  cachedSeedKey(): Promise<CryptoKey | null>;
  cacheSeedKey(key: CryptoKey): Promise<void>;
  forgetSeedKey(): Promise<void>;
  didcomm(): Promise<DidcommApi>;
  /**
   * The trace level this device keeps (`@estoc/vault` §6.10), a device
   * preference the host remembers between runs — never the vault's to
   * carry. Left out: `normal`, and `setTraceLevel` holds for this run.
   */
  traceLevel?(): Promise<TraceLevel>;
  setTraceLevel?(level: TraceLevel): Promise<void>;
  /** Called when the network comes back, if the host can tell. */
  onOnline?(callback: () => void): void;
  /** transports and the like, passed through to the agent */
  agentOptions?: Pick<AgentOptions, "fetch" | "WebSocket" | "packageFetch" | "resolveDid">;
}
