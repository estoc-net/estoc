import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import type { FolderObject } from "@estoc/folder-object";
import {
  Vault,
  type ContactRecord,
  type ImportOutcome,
  type InvitationRecord,
  type MessageRecord,
  type VaultBackend,
} from "@estoc/vault";
import {
  Agent,
  createVault,
  openVault,
  type AgentStatus,
  type Invitation,
  type PeerVault,
  type SendOptions,
  type VerifiedShare,
} from "@estoc/agent-core";

import type { Daemon, Phase, Snapshot } from "./api.js";
import { exportBackup, importBackup } from "./backup.js";
import type { DaemonHost } from "./host.js";

/** How the daemon raises an event: a name and its arguments, to whoever listens. */
export type Emit = (name: string, ...args: unknown[]) => void;

/** The daemon as its host holds it: the UI's interface, and a replay for one listener. */
export interface DaemonCore extends Daemon {
  /** whether `boot()` has run: a later `boot()` is a replay */
  readonly booted: boolean;
  /** Say where things stand again, to `to` alone — for a listener that was not there the first time. */
  replayTo(to: Emit): Promise<void>;
}

/**
 * The daemon itself, wherever it runs: the vault at the host's backend,
 * the lock on it, the seed unlocked from the keystore and cached where the
 * host keeps such things, and the agent that writes to the vault and
 * reports back through events. A UI renders what those events say and
 * asks for things through the `Daemon` methods; nothing of the vault is
 * reachable any other way.
 *
 * `boot` is the entry and may be called again — by a second UI joining a
 * daemon already up, or one reconnecting — in which case it replays where
 * things stand rather than opening anything twice.
 */
export function createDaemon(host: DaemonHost, emit: Emit): DaemonCore {
  let backend: VaultBackend | null = null;
  let vault: PeerVault | null = null;
  let seedKey: CryptoKey | null = null;
  let agent: Agent | null = null;
  let booted = false;
  let current: Phase = "booting";
  let lastStatus: AgentStatus = { state: "idle" };

  const phase = (p: Phase) => {
    current = p;
    emit("phase", p);
  };
  const log = (line: string) => emit("log", line);
  const status = (s: AgentStatus, did: string | null) => {
    lastStatus = s;
    emit("status", s, did);
  };
  const failure = (err: unknown) => (err instanceof Error ? err.message : String(err));

  async function snapshot(v: PeerVault): Promise<Snapshot> {
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

  async function attachAgent(v: PeerVault, key: CryptoKey): Promise<void> {
    const didcomm = await host.didcomm();
    const a = new Agent({
      ...host.agentOptions,
      vault: v,
      seedKey: key,
      didcomm,
      events: {
        onStatus: (s) => status(s, a.did),
        onMessage: (record, contact) => emit("message", record, contact),
        onDelivery: (event) => emit("delivery", event),
        onContact: (record) => emit("contact", record, false),
        onInvitation(record) {
          // issued or taken: the record; revoked: the record, no longer in the vault
          void a.vault.invitations.byId(record.id).then((still) => emit("invitation", record, still === null));
        },
        onLog: log,
      },
    });
    agent = a;
    await a.start();
  }

  /** A vault and its unlocked seed are in hand: report, start. */
  async function open(v: PeerVault, key: CryptoKey): Promise<void> {
    vault = v;
    seedKey = key;
    current = "open";
    emit("opened", await snapshot(v));
    void attachAgent(v, key).catch((err) => status({ state: "error", detail: failure(err) }, null));
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
  host.onOnline?.(() => {
    if (agent === null) {
      return;
    }
    const a = agent;
    const again =
      lastStatus.state === "error" ? a.start() : lastStatus.state === "live" ? a.flush() : Promise.resolve();
    again.catch((err) => log(`back online: ${failure(err)}`));
  });

  async function replayTo(to: Emit): Promise<void> {
    if (current === "open" && vault !== null) {
      to("opened", await snapshot(vault));
      to("status", lastStatus, agent?.did ?? null);
      return;
    }
    to("phase", current);
  }

  return {
    get booted() {
      return booted;
    },
    replayTo,
    async boot() {
      if (booted) {
        await replayTo(emit);
        return;
      }
      booted = true;
      await host.lock(() => phase("elsewhere"));
      try {
        backend = await host.backend();
      } catch (err) {
        status({ state: "error", detail: failure(err) }, null);
        phase("onboarding");
        return;
      }
      if (!(await Vault.exists(backend))) {
        phase("onboarding");
        return;
      }
      let v: PeerVault;
      try {
        v = await openVault(backend);
      } catch (err) {
        // a vault this version cannot read: written by a newer client, or by
        // an older format this one does not migrate — say so, and leave the
        // bytes alone until the person decides
        status({ state: "error", detail: failure(err) }, null);
        phase("unreadable");
        return;
      }
      const key = await host.cachedSeedKey();
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
      const v = await createVault(backend, { label: name, keystore: doc, seedKey: key });
      await host.cacheSeedKey(key);
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
      const v = await openVault(backend);
      let key: CryptoKey;
      try {
        key = await unlockSeedKeystore(v.keystore, passphrase);
      } catch {
        // wrong passphrase: leave no half-restored vault behind
        await host.wipe();
        throw new Error("that passphrase does not open this backup");
      }
      await host.cacheSeedKey(key);
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
      await host.cacheSeedKey(key);
      await open(vault, key);
    },

    async lock() {
      stopAgent();
      seedKey = null;
      await host.forgetSeedKey();
      status({ state: "idle" }, null);
      phase("locked");
    },

    async forgetIdentity() {
      stopAgent();
      vault = null;
      seedKey = null;
      await host.forgetSeedKey();
      await host.wipe();
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
      await open(await openVault(backend), seedKey);
      return outcome;
    },

    async setMediator(mediatorDid) {
      const a = running();
      await a.setMediator(mediatorDid);
      // every DID was minted anew: every client is told the whole of it
      emit("opened", await snapshot(a.vault));
      return a.did;
    },
    addContact: (did, label): Promise<ContactRecord> => running().addContact(did, label),
    async removeContact(cid) {
      const a = running();
      const record = await a.vault.contacts.byCid(cid);
      await a.removeContact(cid);
      if (record !== null) {
        emit("contact", record, true);
      }
    },
    acceptInvitation: (invitation: Invitation, label): Promise<ContactRecord> =>
      running().acceptInvitation(invitation, label),
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
