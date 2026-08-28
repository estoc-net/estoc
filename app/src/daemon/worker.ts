import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import type { FolderObject } from "@estoc/folder-object";
import {
  Agent,
  Vault,
  type AgentStatus,
  type ContactRecord,
  type ImportOutcome,
  type Invitation,
  type InvitationRecord,
  type MessageRecord,
  type SendOptions,
  type VaultBackend,
  type VerifiedShare,
} from "@estoc/agent-core";

import { FromPrior, Message, initDidcomm } from "../didcomm/wasm.js";
import { exportBackup, importBackup } from "../core/backup.js";
import { vaultBackend, wipeVault } from "../core/storage.js";
import type { Daemon, Phase, Snapshot } from "./api.js";
import { cacheSeedKey, cachedSeedKey, forgetSeedKey } from "./keycache.js";
import { acquireVaultLock } from "./lock.js";
import { serve } from "./rpc.js";

/**
 * The daemon, in a dedicated worker: one vault per origin at the root of
 * OPFS, the lock on it, the seed unlocked from the keystore and cached in
 * IndexedDB between sessions, and the agent that writes to the vault and
 * reports back through events. The page it belongs to renders what those
 * events say and asks for things through the `Daemon` methods; nothing of
 * the vault is reachable from the page any other way.
 *
 * Its life is the tab's. A shared worker would make it the tabs', a push
 * handler would wake it without any — the interface is the same.
 */

const emit = serve(self, daemon());

function daemon(): Daemon {
  let backend: VaultBackend | null = null;
  let vault: Vault | null = null;
  let seedKey: CryptoKey | null = null;
  let agent: Agent | null = null;

  const phase = (p: Phase) => emit("phase", p);
  const log = (line: string) => emit("log", line);
  let lastStatus: AgentStatus["state"] = "idle";
  const status = (s: AgentStatus, did: string | null) => {
    lastStatus = s.state;
    emit("status", s, did);
  };

  async function snapshot(v: Vault): Promise<Snapshot> {
    let damaged = 0;
    const contacts = await v.contacts.all();
    const invitations = await v.invitations.all();
    const messages = await v.messages.read(() => (damaged += 1));
    const deliveries = await v.deliveries.read(() => (damaged += 1));
    return {
      label: v.config.label,
      mediatorDid: v.config.mediation?.mediatorDid ?? null,
      did: v.config.mediation?.public?.did ?? null,
      contacts,
      invitations,
      messages,
      deliveries,
      damaged,
    };
  }

  async function attachAgent(v: Vault, key: CryptoKey): Promise<void> {
    const a = new Agent({
      vault: v,
      seedKey: key,
      didcomm: { Message, FromPrior },
      events: {
        onStatus: (s) => status(s, a.did),
        onMessage: (record, contact) => emit("message", record, contact),
        onDelivery: (event) => emit("delivery", event),
        onContact: (record) => emit("contact", record),
        onInvitation(record) {
          // issued or taken: the record; revoked: the record, no longer in the vault
          void a.vault.invitations.byId(record.id).then((still) => emit("invitation", record, still === null));
        },
        onLog: log,
      },
    });
    agent = a;
    await initDidcomm();
    await a.start();
  }

  /** A vault and its unlocked seed are in hand: report, start. */
  async function open(v: Vault, key: CryptoKey): Promise<void> {
    vault = v;
    seedKey = key;
    emit("opened", await snapshot(v));
    void attachAgent(v, key).catch((err) => {
      status({ state: "error", detail: err instanceof Error ? err.message : String(err) }, null);
    });
  }

  function stopAgent(): void {
    agent?.destroy();
    agent = null;
  }

  function running(): Agent {
    if (agent === null) {
      throw new Error("the agent is not running");
    }
    return agent;
  }

  /**
   * The network came back. An agent that could not come up without it
   * would try again by itself in a while; it is told to try now. A live
   * one sends what waited in the outbox without waiting for the socket.
   */
  self.addEventListener("online", () => {
    if (agent === null) {
      return;
    }
    const a = agent;
    const again = lastStatus === "error" ? a.start() : lastStatus === "live" ? a.flush() : Promise.resolve();
    again.catch((err) => log(`back online: ${err instanceof Error ? err.message : String(err)}`));
  });

  return {
    async boot() {
      await acquireVaultLock(() => phase("elsewhere"));
      try {
        backend = await vaultBackend();
      } catch (err) {
        status({ state: "error", detail: err instanceof Error ? err.message : String(err) }, null);
        phase("onboarding");
        return;
      }
      if (!(await Vault.exists(backend))) {
        phase("onboarding");
        return;
      }
      let v: Vault;
      try {
        v = await Vault.open(backend);
      } catch (err) {
        // a vault this version cannot read: written by a newer client, or by
        // an older format this one does not migrate — say so, and leave the
        // bytes alone until the person decides
        status({ state: "error", detail: err instanceof Error ? err.message : String(err) }, null);
        phase("unreadable");
        return;
      }
      const key = await cachedSeedKey();
      if (key === null) {
        vault = v;
        phase("locked");
        return;
      }
      await open(v, key);
    },

    async createIdentity(name, passphrase) {
      if (backend === null) {
        throw new Error("storage is not available");
      }
      const { doc, seedKey: key } = await createSeedKeystore(passphrase);
      const v = await Vault.create(backend, { label: name, keystore: doc, seedKey: key });
      await cacheSeedKey(key);
      await open(v, key);
    },

    async restoreIdentity(zip, passphrase) {
      if (backend === null) {
        throw new Error("storage is not available");
      }
      const outcome = await importBackup(backend, zip);
      if (outcome.kind !== "restored") {
        throw new Error("a vault already exists here");
      }
      const v = await Vault.open(backend);
      let key: CryptoKey;
      try {
        key = await unlockSeedKeystore(v.keystore, passphrase);
      } catch {
        // wrong passphrase: leave no half-restored vault behind
        await wipeVault();
        throw new Error("that passphrase does not open this backup");
      }
      await cacheSeedKey(key);
      await open(v, key);
    },

    async unlock(passphrase) {
      if (vault === null) {
        throw new Error("nothing to unlock");
      }
      let key: CryptoKey;
      try {
        key = await unlockSeedKeystore(vault.keystore, passphrase);
      } catch {
        throw new Error("wrong passphrase");
      }
      await cacheSeedKey(key);
      await open(vault, key);
    },

    async lock() {
      stopAgent();
      seedKey = null;
      await forgetSeedKey();
      status({ state: "idle" }, null);
      phase("locked");
    },

    async forgetIdentity() {
      stopAgent();
      vault = null;
      seedKey = null;
      await forgetSeedKey();
      await wipeVault();
      status({ state: "idle" }, null);
      phase("onboarding");
    },

    async exportBackup() {
      if (backend === null || vault === null) {
        throw new Error("no open vault");
      }
      return exportBackup(backend, vault.config.label);
    },

    async mergeBackup(zip): Promise<ImportOutcome> {
      if (backend === null || seedKey === null) {
        throw new Error("no open vault to merge into");
      }
      const outcome = await importBackup(backend, zip);
      // the agent is restarted on the merged vault: its stores cache what
      // they read, and the merge wrote past them
      stopAgent();
      await open(await Vault.open(backend), seedKey);
      return outcome;
    },

    async setMediator(mediatorDid) {
      const a = running();
      await a.setMediator(mediatorDid);
      return a.did;
    },
    addContact: (did, label): Promise<ContactRecord> => running().addContact(did, label),
    removeContact: (cid) => running().removeContact(cid),
    acceptInvitation: (invitation: Invitation, label): Promise<ContactRecord> => running().acceptInvitation(invitation, label),
    async createInvitation(): Promise<InvitationRecord> {
      const a = running();
      try {
        return await a.createInvitation();
      } catch (err) {
        // the record may exist unregistered (the mediator could not be told):
        // report it as not ready rather than pretend nothing happened
        for (const record of await a.vault.invitations.all()) {
          emit("invitation", record, false);
        }
        throw err;
      }
    },
    revokeInvitation: (id) => running().revokeInvitation(id),
    send: (contactDid, type, body, options?: SendOptions): Promise<MessageRecord> =>
      running().send(contactDid, type, body, options),
    shareObject: (contactDid, object: FolderObject, options) => running().shareObject(contactDid, object, options),
    fetchPackage: (record): Promise<VerifiedShare> => running().fetchPackage(record),
    blob: (cid) => (agent === null ? Promise.resolve(null) : agent.vault.blobs.get(cid)),
    async retry(mid) {
      await running().retry(mid);
    },
  };
}
