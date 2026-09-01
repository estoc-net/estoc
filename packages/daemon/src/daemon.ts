import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import type { FolderObject } from "@estoc/folder-object";
import { CONFIG_PATH, importVault, restoreFolder, type FolderVault, type Imported, type VaultBackend } from "@estoc/event-store";
import { holdImported, importPolicy, type Delivery, type VaultFold } from "@estoc/vault/v2";
import type { VerifiedShare } from "@estoc/agent-core";
import {
  Agent,
  AgentTrace,
  attributedTo,
  contactRecord,
  createVault,
  inspectVault,
  invitationRecord,
  isTraceLevel,
  messageRecord,
  openVault,
  type AgentStatus,
  type ContactRecord,
  type Inspected,
  type Invitation,
  type MessageRecord,
  type PeerVault,
  type SendOptions,
  type TraceLevel,
} from "@estoc/agent-core/v2";

import type { Daemon, Phase, Snapshot, SnapshotMessage } from "./api.js";
import { exportBackup, filesFromZip } from "./backup.js";
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

/** The public DID the fold says this device's mediation publishes: what `Keyring.pub` reads, without the agent. */
function publicDidOf(fold: VaultFold): string | null {
  const mediation = fold.device(fold.self)?.mediation ?? null;
  if (mediation === null || mediation.routingDid === null) {
    return null;
  }
  const profiles = fold
    .myKeys()
    .filter(
      (key) =>
        key.minted !== null &&
        key.minted.mediation === mediation.id &&
        key.minted.routingDid === mediation.routingDid &&
        key.retired === null &&
        key.published.some((entry) => entry.as === "profile")
    );
  return profiles.at(-1)?.minted?.did ?? null;
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
  /** the folder in hand: the inspected one while locked, the opened vault's after */
  let folder: FolderVault | null = null;
  /** the locked phase's read: the folder and the sealed keystore, for `unlock` */
  let inspected: Inspected | null = null;
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
    const fold = v.fold;
    const messages: SnapshotMessage[] = [];
    const deliveries: Delivery[] = [];
    let unreadable = 0;
    for (const message of fold.messages()) {
      // a deleted contact's channels are tombstoned (§9): nothing of them is shown
      const attribution = fold.attribution(message.pair);
      if (attribution.kind === "deleted") {
        continue;
      }
      const record = await messageRecord(fold, v.vault.blobs, message.mid);
      if (record === null) {
        continue;
      }
      if (record.body === "missing") {
        unreadable += 1;
      }
      messages.push({ record, contactCid: attributedTo(attribution) });
      if (message.delivery !== null) {
        deliveries.push(message.delivery);
      }
    }
    return {
      label: fold.label() ?? "",
      mediatorDid: fold.device(fold.self)?.mediation?.mediatorDid ?? null,
      did: publicDidOf(fold),
      contacts: fold.contacts().map(contactRecord),
      invitations: fold
        .invitations()
        .map((invitation) => invitationRecord(fold, invitation))
        .filter((record) => !record.retired),
      messages,
      deliveries,
      damaged: v.vault.events.damaged().length + unreadable,
    };
  }

  async function attachAgent(v: PeerVault): Promise<void> {
    const didcomm = await host.didcomm();
    const a = new Agent({
      ...host.agentOptions,
      vault: v,
      didcomm,
      events: {
        onStatus: (s) => status(s, a.did),
        onMessage: (record, contact) => emit("message", record, contact),
        onDelivery: (delivery, record) => emit("delivery", delivery, record),
        onContact: (record) => emit("contact", record, false),
        // issued or taken: the record; revoked or withdrawn: the record, retired
        onInvitation: (record) => emit("invitation", record, record.retired),
        onLog: log,
      },
    });
    agent = a;
    await a.start();
  }

  /** A vault and its unlocked seed are in hand: report, start. */
  async function open(v: PeerVault, key: CryptoKey): Promise<void> {
    vault = v;
    folder = v.vault;
    inspected = null;
    seedKey = key;
    current = "open";
    emit("opened", await snapshot(v));
    void attachAgent(v).catch((err) => status({ state: "error", detail: failure(err) }, null));
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
   * The trace over this device's `local/agent/`, from the folder in hand
   * — the locked one or the open vault's — so `traceOf` and the level
   * answer without the agent (which attaches after `opened`). Writes go
   * through the running agent when there is one: its own instance caches
   * the level, and a write around it would leave that cache stale.
   */
  async function traced(): Promise<AgentTrace> {
    if (folder === null) {
      throw new Error("no vault: the trace lives in it");
    }
    return AgentTrace.open(folder.local("agent"));
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
      if ((await backend.size(CONFIG_PATH)) === null) {
        phase("onboarding");
        return;
      }
      try {
        inspected = await inspectVault(backend);
      } catch (err) {
        // a vault this version cannot read: written by a newer client, or by
        // the version 1 format this one does not migrate — say so, and leave
        // the bytes alone until the person decides
        status({ state: "error", detail: failure(err) }, null);
        phase("unreadable");
        return;
      }
      folder = inspected.vault;
      const key = await host.cachedSeedKey();
      if (key === null) {
        phase("locked");
        return;
      }
      await open(await openVault(backend, key), key);
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
      if ((await backend.size(CONFIG_PATH)) !== null) {
        throw new Error("a vault already exists here");
      }
      // a zip that does not unpack fails before a byte lands
      const files = filesFromZip(zip);
      let key: CryptoKey;
      let v: PeerVault;
      try {
        await restoreFolder(backend, files);
        const restored = await inspectVault(backend);
        try {
          key = await unlockSeedKeystore(restored.keystore, passphrase);
        } catch {
          throw new Error("that passphrase does not open this backup");
        }
        v = await openVault(backend, key);
        // the snapshot carried no local/, so this open is a fresh device: the
        // old device's unsent mail is held, not this one's to send (§10); a
        // mediation of this device's own is chosen in the UI afterwards
        await holdImported(v.vault.events, v.fold);
      } catch (err) {
        // whatever refused the backup once its files were down — no
        // keystore, not a vault, the wrong passphrase, a seed that is not
        // the anchor's — leaves no half-restored vault behind: the next
        // try, with another zip or passphrase, starts from the empty folder
        await host.wipe();
        throw err;
      }
      await host.cacheSeedKey(key);
      await open(v, key);
    },

    async unlock(passphrase) {
      if (inspected === null || backend === null) {
        throw new Error("nothing to unlock");
      }
      let key: CryptoKey;
      try {
        key = await unlockSeedKeystore(inspected.keystore, passphrase);
      } catch {
        throw new Error("wrong passphrase");
      }
      await host.cacheSeedKey(key);
      await open(await openVault(backend, key), key);
    },

    async lock() {
      stopAgent();
      vault = null;
      seedKey = null;
      if (backend !== null) {
        // the folder stays in hand, seedless, so unlock (and the trace) can read it
        inspected = await inspectVault(backend);
        folder = inspected.vault;
      }
      await host.forgetSeedKey();
      status({ state: "idle" }, null);
      phase("locked");
    },

    async forgetIdentity() {
      stopAgent();
      vault = null;
      folder = null;
      inspected = null;
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
      return exportBackup(backend, vault.fold.label() ?? "vault");
    },

    async mergeBackup(zip): Promise<Imported> {
      if (backend === null || vault === null || seedKey === null) {
        throw new Error("no open vault to merge into");
      }
      const outcome = await importVault(vault.vault, filesFromZip(zip), importPolicy());
      // the agent is restarted on the merged vault: the fold and every cache
      // were read before the merge wrote past them
      stopAgent();
      const reopened = await openVault(backend, seedKey);
      // what another device wrote and did not send is not sent by this one
      // unasked (§10); the cache learns the keys the merged log minted
      await holdImported(reopened.vault.events, reopened.fold);
      await reopened.keys.rebuildCache(reopened.fold);
      await open(reopened, seedKey);
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
      const contact = a.vault.fold.contact(cid);
      await a.removeContact(cid);
      if (contact !== null) {
        emit("contact", contactRecord(contact), true);
      }
    },
    acceptInvitation: (invitation: Invitation, label): Promise<ContactRecord> =>
      running().acceptInvitation(invitation, label),
    async createInvitation() {
      const a = running();
      try {
        return await a.createInvitation();
      } catch (err) {
        // a key may be minted and published yet unregistered (the mediator
        // could not be told): report it as not ready rather than pretend
        // nothing happened
        for (const record of a.invitations()) {
          emit("invitation", record, record.retired);
        }
        throw err;
      }
    },
    revokeInvitation: (id) => running().revokeInvitation(id),
    send: (contactDid, type, body, options?: SendOptions): Promise<MessageRecord> =>
      running().send(contactDid, type, body, options),
    shareObject: (contactDid, object: FolderObject, options) => running().shareObject(contactDid, object, options),
    fetchPackage: (record): Promise<VerifiedShare> => running().fetchPackage(record),
    blob: (cid) => (vault === null ? Promise.resolve(null) : vault.vault.blobs.get(cid)),
    async retry(mid) {
      await running().retry(mid);
    },

    traceOf: async (mid) => (folder === null ? [] : (await traced()).traceOf(mid)),
    traceLevel: async (): Promise<TraceLevel> => (folder === null ? "normal" : (await traced()).level),
    async setTraceLevel(level) {
      if (!isTraceLevel(level)) {
        throw new Error(`no such trace level: ${String(level)}`);
      }
      if (agent !== null) {
        await agent.setTraceLevel(level);
      } else {
        await (await traced()).setLevel(level);
      }
      return level;
    },
  };
}
