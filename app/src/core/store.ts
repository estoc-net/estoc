import { reactive } from "vue";
import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import {
  Agent,
  Vault,
  chatView,
  currentDid,
  currentMyDid,
  type ContactRecord,
  type ImportOutcome,
  type VaultBackend,
} from "@estoc/agent-core";

import { FromPrior, Message, initDidcomm } from "../didcomm/wasm.js";
import { exportBackup, importBackup, saveFile } from "./backup.js";
import { cacheSeedKey, cachedSeedKey, forgetSeedKey } from "./keycache.js";
import { acquireVaultLock } from "./lock.js";
import { isInstalled, setupPwa } from "./pwa.js";
import { isStoragePersisted, persistStorage, vaultBackend, wipeVault } from "./storage.js";
import type { AgentStatus, ChatMessage, Contact, Identity, Phase } from "./types.js";

/**
 * The one store: this install's identity as Vue-reactive views, plus the
 * runtime around it (agent status, activity log, storage and install
 * state). One vault per origin, at the root of OPFS; the agent writes
 * there and reports back through events, which update the views — so the
 * UI renders what the vault holds, never the other way round.
 *
 * The passphrase is typed when the identity is created or restored, and
 * again only after "Lock": the unlocked seed is cached as a non-extractable
 * CryptoKey in IndexedDB between sessions (see keycache.ts). The zip a
 * backup exports carries the seed sealed under that passphrase.
 */

export const state = reactive({
  phase: "booting" as Phase,
  identity: null as Identity | null,
  status: { state: "idle" } as AgentStatus,
  log: [] as string[],
  /** whether the browser has promised not to evict this origin's storage */
  persisted: false,
  installed: isInstalled(),
  /** set when the browser offers to install; call to prompt */
  install: null as (() => Promise<void>) | null,
  /** set when a new version is waiting; call to reload into it */
  applyUpdate: null as (() => void) | null,
  /** true once the service worker has the shell cached */
  offlineReady: false,
});

let backend: VaultBackend | null = null;
let vault: Vault | null = null;
let seedKey: CryptoKey | null = null;
let agent: Agent | null = null;

function log(line: string): void {
  state.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
  if (state.log.length > 200) {
    state.log.shift();
  }
}

function contactView(record: ContactRecord): Contact {
  return {
    cid: record.cid,
    did: currentDid(record),
    myDid: currentMyDid(record)?.did ?? null,
    label: record.name,
    ...(record.claimedName === undefined ? {} : { claimedName: record.claimedName }),
  };
}

function upsertContact(identity: Identity, record: ContactRecord): void {
  const view = contactView(record);
  const index = identity.contacts.findIndex((c) => c.cid === record.cid);
  if (index === -1) {
    identity.contacts.push(view);
  } else {
    identity.contacts[index] = view;
  }
}

/** Project the vault into views. */
async function viewsOf(v: Vault): Promise<Identity> {
  // Threads are keyed by contact, not by DID: a contact's DIDs are a
  // history, and every message is homed through it.
  const contacts = await v.contacts.all();
  const cidOf = new Map<string, string>();
  for (const contact of contacts) {
    for (const use of contact.dids) {
      cidOf.set(use.did, contact.cid);
    }
  }
  const messages: ChatMessage[] = [];
  let damaged = 0;
  for (const record of await v.messages.read(() => (damaged += 1))) {
    const view = chatView(record);
    if (view !== null) {
      const cid = cidOf.get(view.contactDid);
      messages.push(cid === undefined ? view : { ...view, contactCid: cid });
    }
  }
  if (damaged > 0) {
    log(`skipped ${damaged} damaged line${damaged === 1 ? "" : "s"} in the message log`);
  }
  return {
    name: v.config.label,
    mediatorDid: v.config.mediation?.mediatorDid ?? null,
    did: v.config.mediation?.public?.did ?? null,
    contacts: contacts.map(contactView),
    messages,
  };
}

async function attachAgent(): Promise<void> {
  if (vault === null || seedKey === null || state.identity === null) {
    return;
  }
  const identity = state.identity;
  const a = new Agent({
    vault,
    seedKey,
    didcomm: { Message, FromPrior },
    events: {
      onStatus(status) {
        state.status = status;
        identity.did = a.did;
      },
      onMessage(_record, view: ChatMessage) {
        identity.messages.push(view);
      },
      onContact(record) {
        upsertContact(identity, record);
      },
      onLog: log,
    },
  });
  agent = a;
  await initDidcomm();
  await a.start();
}

/** A vault and its unlocked seed are in hand: project, start, show. */
async function open(v: Vault, key: CryptoKey): Promise<void> {
  vault = v;
  seedKey = key;
  state.identity = await viewsOf(v);
  state.phase = "open";
  state.persisted = await isStoragePersisted();
  void attachAgent().catch((err) => {
    state.status = { state: "error", detail: err instanceof Error ? err.message : String(err) };
  });
}

/**
 * Bring the app up: take the vault lock (or wait for the tab that has it),
 * then land on the screen the disk dictates — nothing here, a vault
 * without its cached seed, or straight in.
 */
export async function boot(): Promise<void> {
  setupPwa({
    onUpdateReady: (apply) => (state.applyUpdate = apply),
    onOfflineReady: () => (state.offlineReady = true),
    onInstallable: (prompt) => (state.install = prompt),
  });
  await acquireVaultLock(() => (state.phase = "elsewhere"));
  try {
    backend = await vaultBackend();
  } catch (err) {
    state.phase = "onboarding";
    state.status = { state: "error", detail: err instanceof Error ? err.message : String(err) };
    return;
  }
  if (!(await Vault.exists(backend))) {
    state.phase = "onboarding";
    return;
  }
  const v = await Vault.open(backend);
  const key = await cachedSeedKey();
  if (key === null) {
    vault = v;
    state.phase = "locked";
    return;
  }
  await open(v, key);
}

/**
 * Mint an identity: a fresh seed sealed under `passphrase`, a vault around
 * it. No mediator yet — an identity is a seed and a name; how it is reached
 * is decided afterwards (`chooseMediator`).
 */
export async function createIdentity(name: string, passphrase: string): Promise<void> {
  if (backend === null) {
    throw new Error("storage is not available");
  }
  const { doc, seedKey: key } = await createSeedKeystore(passphrase);
  const v = await Vault.create(backend, { label: name, keystore: doc, seedKey: key });
  await cacheSeedKey(key);
  state.persisted = await persistStorage();
  await open(v, key);
}

/**
 * Name the mediator this identity will be reached through, and go live:
 * mediation, the public DID, pickup. Once, for an identity that has none —
 * changing it later is a public-DID rotation the app does not offer yet.
 */
export async function chooseMediator(mediatorDid: string): Promise<void> {
  if (agent === null || state.identity === null) {
    throw new Error("the agent is not running");
  }
  await agent.setMediator(mediatorDid);
  state.identity.mediatorDid = mediatorDid;
  state.identity.did = agent.did;
}

/** Restore a backup zip into an empty install, unlocking it with its passphrase. */
export async function restoreIdentity(zip: Uint8Array, passphrase: string): Promise<void> {
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
  } catch (err) {
    // wrong passphrase: leave no half-restored vault behind
    await wipeVault();
    throw new Error("that passphrase does not open this backup");
  }
  await cacheSeedKey(key);
  state.persisted = await persistStorage();
  await open(v, key);
}

/** The vault is here but its seed is not cached: the passphrase opens it. */
export async function unlock(passphrase: string): Promise<void> {
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
}

/** Forget the cached seed; the vault stays, the passphrase is asked next time. */
export async function lock(): Promise<void> {
  agent?.destroy();
  agent = null;
  seedKey = null;
  await forgetSeedKey();
  state.identity = null;
  state.status = { state: "idle" };
  state.phase = "locked";
}

/** Delete the vault and the cached seed. There is nothing to recover afterwards. */
export async function forgetIdentity(): Promise<void> {
  agent?.destroy();
  agent = null;
  vault = null;
  seedKey = null;
  await forgetSeedKey();
  await wipeVault();
  state.identity = null;
  state.status = { state: "idle" };
  state.log = [];
  state.phase = "onboarding";
}

/** Zip the vault and hand it to the browser as a download. */
export async function downloadBackup(): Promise<void> {
  if (backend === null || state.identity === null) {
    return;
  }
  const { name, bytes } = await exportBackup(backend, state.identity.name);
  saveFile(name, bytes);
  log(`exported ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

/**
 * Merge a backup zip into the open vault. The agent is restarted on the
 * merged vault afterwards: its stores cache what they read, and the merge
 * wrote past them.
 */
export async function mergeBackup(zip: Uint8Array): Promise<ImportOutcome> {
  if (backend === null || seedKey === null) {
    throw new Error("no open vault to merge into");
  }
  const outcome = await importBackup(backend, zip);
  if (outcome.kind === "merged") {
    log(
      `merged a backup: ${outcome.messagesAdded} new message${outcome.messagesAdded === 1 ? "" : "s"}, ` +
        `${outcome.contactsAdded} new contact${outcome.contactsAdded === 1 ? "" : "s"}, ` +
        `${outcome.contactsUpdated} updated`
    );
  }
  agent?.destroy();
  agent = null;
  await open(await Vault.open(backend), seedKey);
  return outcome;
}

export async function addContact(did: string, label: string): Promise<Contact | null> {
  if (agent === null || state.identity === null) {
    return null;
  }
  // Adding a DID that already arrived as a stranger renames the auto-created
  // contact instead of duplicating it — the agent handles that.
  const record = await agent.addContact(did, label);
  upsertContact(state.identity, record);
  return state.identity.contacts.find((c) => c.cid === record.cid) ?? null;
}

export async function removeContact(cid: string): Promise<void> {
  if (agent === null || state.identity === null) {
    return;
  }
  await agent.removeContact(cid);
  state.identity.contacts = state.identity.contacts.filter((c) => c.cid !== cid);
}

export async function sendMessage(contactDid: string, text: string): Promise<void> {
  if (agent === null) {
    throw new Error("the agent is not running");
  }
  await agent.sendBasicMessage(contactDid, text);
}
