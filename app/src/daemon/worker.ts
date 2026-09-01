import { ESTOC_DIR, OpfsBackend } from "@estoc/event-store";
import type { DidcommApi } from "@estoc/agent-core";
import { createDaemon, serve, type DaemonHost, type Emit } from "@estoc/daemon";

import { FromPrior, Message, initDidcomm } from "../didcomm/wasm.js";
import { cacheSeedKey, cachedSeedKey, forgetSeedKey } from "./keycache.js";
import { acquireVaultLock } from "./lock.js";

/**
 * The daemon in a dedicated worker of this page: the vault is `.estoc/`
 * at the root of this origin's private file system (one identity per
 * install, the folder itself the format), one agent per vault is kept by
 * Web Locks across tabs, and the unlocked seed waits in IndexedDB between
 * sessions as a non-extractable key. Its life is the tab's.
 */
const host: DaemonHost = {
  lock: acquireVaultLock,
  backend: async () => new OpfsBackend(await navigator.storage.getDirectory()),
  async wipe() {
    const root = await navigator.storage.getDirectory();
    try {
      await root.removeEntry(ESTOC_DIR, { recursive: true });
    } catch (err) {
      if ((err as { name?: string }).name !== "NotFoundError") {
        throw err;
      }
    }
  },
  cachedSeedKey,
  cacheSeedKey,
  forgetSeedKey,
  async didcomm(): Promise<DidcommApi> {
    await initDidcomm();
    return { Message, FromPrior };
  },
  onOnline: (callback) => self.addEventListener("online", callback),
};

let emit: Emit = () => undefined;
const daemon = createDaemon(host, (name, ...args) => emit(name, ...args));
emit = serve(self, daemon);
