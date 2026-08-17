import { reactive } from "vue";
import { createSeedKeystore, unlockSeedKeystore } from "@estoc/keystore";
import {
  Agent,
  BASIC_MESSAGE,
  Vault,
  counterpartyOf,
  currentDid,
  currentMyDid,
  foldDeliveries,
  invitationMessage,
  invitationUrl,
  parseInvitation,
  type ContactRecord,
  type ImportOutcome,
  type Invitation,
  type InvitationRecord,
  type MessageRecord,
  type SendOptions,
  type VaultBackend,
} from "@estoc/agent-core";

import { FromPrior, Message, initDidcomm } from "../didcomm/wasm.js";
import { exportBackup, importBackup, saveFile } from "./backup.js";
import { entryOf } from "./entries.js";
import { cacheSeedKey, cachedSeedKey, forgetSeedKey } from "./keycache.js";
import { acquireVaultLock } from "./lock.js";
import { isInstalled, setupPwa } from "./pwa.js";
import { isStoragePersisted, persistStorage, vaultBackend, wipeVault } from "./storage.js";
import type {
  AgentStatus,
  Contact,
  Entry,
  Identity,
  InvitationView,
  Phase,
} from "./types.js";

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
  /**
   * An invitation this page was opened with (`?_oob=` in the URL) and has
   * not acted on yet: a person's waits for the chat pane to offer "add
   * them"; a mediator's is offered where a mediator is chosen. Kept here,
   * not in the URL, so it survives onboarding and unlocking.
   */
  pendingInvitation: null as Invitation | null,
  pendingMediatorInvitation: null as string | null,
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

/**
 * The link an invitation of ours is handed over as: this deployment's
 * origin, so tapping it opens *an* Estoc — the same one that issued it,
 * or any other; only `_oob` matters to the app that opens it.
 */
export function invitationLink(record: InvitationRecord): string {
  return invitationUrl(`${location.origin}${location.pathname}`, invitationMessage(record));
}

function invitationView(record: InvitationRecord): InvitationView {
  return {
    id: record.id,
    goal: record.goal,
    createdAt: record.createdAt,
    url: invitationLink(record),
    ready: record.registeredAt !== undefined,
    takenBy: record.acceptedBy ?? null,
  };
}

function upsertInvitation(identity: Identity, record: InvitationRecord, gone = false): void {
  const index = identity.invitations.findIndex((i) => i.id === record.id);
  if (gone) {
    if (index !== -1) {
      identity.invitations.splice(index, 1);
    }
    return;
  }
  const view = invitationView(record);
  if (index === -1) {
    identity.invitations.push(view);
  } else {
    identity.invitations[index] = view;
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
  const messages: Entry[] = [];
  let damaged = 0;
  for (const record of await v.messages.read(() => (damaged += 1))) {
    const did = counterpartyOf(record);
    messages.push(entryOf(record, did === null ? null : (cidOf.get(did) ?? null)));
  }
  const deliveries = Object.fromEntries(foldDeliveries(await v.deliveries.read(() => (damaged += 1))));
  if (damaged > 0) {
    log(`skipped ${damaged} damaged line${damaged === 1 ? "" : "s"} in the logs`);
  }
  return {
    name: v.config.label,
    mediatorDid: v.config.mediation?.mediatorDid ?? null,
    did: v.config.mediation?.public?.did ?? null,
    contacts: contacts.map(contactView),
    invitations: (await v.invitations.all()).map(invitationView),
    messages,
    deliveries,
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
      onMessage(record, contact) {
        identity.messages.push(entryOf(record, contact?.cid ?? null));
      },
      onDelivery(event) {
        const prior = identity.deliveries[event.mid];
        identity.deliveries[event.mid] = {
          status: event.status,
          attempts: Math.max(prior?.attempts ?? 0, event.attempt),
          at: event.at,
          ...(event.to === undefined ? {} : { to: event.to }),
          ...(event.error === undefined ? {} : { error: event.error }),
        };
      },
      onContact(record) {
        upsertContact(identity, record);
      },
      onInvitation(record) {
        // issued or taken: the record; revoked: the record, no longer in the vault
        void a.vault.invitations.byId(record.id).then((still) => {
          upsertInvitation(identity, record, still === null);
        });
      },
      onLog: log,
    },
  });
  agent = a;
  await initDidcomm();
  await a.start();
}

/**
 * The network came back (the browser says so). An agent that could not
 * come up without it — a start that failed offline — would try again by
 * itself in a while; it is told to try now. A live one sends what waited
 * in the outbox without waiting for the socket to notice.
 */
async function backOnline(): Promise<void> {
  if (agent === null || state.phase !== "open") {
    return;
  }
  if (state.status.state === "error") {
    await agent.start();
  } else if (state.status.state === "live") {
    await agent.flush();
  }
}
window.addEventListener("online", () => {
  void backOnline().catch((err) => log(`back online: ${err instanceof Error ? err.message : String(err)}`));
});

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
  takePendingInvitation();
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
  let v: Vault;
  try {
    v = await Vault.open(backend);
  } catch (err) {
    // a vault this version cannot read: written by a newer client, or by
    // an older format this one does not migrate — say so, and leave the
    // bytes alone until the person decides
    state.status = { state: "error", detail: err instanceof Error ? err.message : String(err) };
    state.phase = "unreadable";
    return;
  }
  const key = await cachedSeedKey();
  if (key === null) {
    vault = v;
    state.phase = "locked";
    return;
  }
  await open(v, key);
}

/**
 * An `_oob` in this page's URL is an invitation someone handed over as a
 * link. Take it off the URL (a reload should not re-offer it, and it should
 * not ride into a bookmark) and hold it until a screen can act on it.
 */
function takePendingInvitation(): void {
  const params = new URLSearchParams(location.search);
  const oob = params.get("_oob");
  if (oob === null) {
    return;
  }
  const clean = `${location.pathname}${location.hash}`;
  try {
    const invitation = parseInvitation(oob);
    if (invitation.body.goal_code === "request-mediate") {
      state.pendingMediatorInvitation = location.href;
    } else {
      state.pendingInvitation = invitation;
    }
  } catch (err) {
    log(`the link this page was opened with is not an invitation: ${err instanceof Error ? err.message : err}`);
  }
  history.replaceState(null, "", clean);
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
 * mediation, the public DID, pickup. For an identity that has one already
 * this is a move: every DID is minted anew on the new mediator (the agent
 * tells each contact by `from_prior`; open invitations are withdrawn —
 * the contact and invitation events keep the views current), and the
 * public DID on the rail is replaced.
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
        `${outcome.contactsUpdated} updated` +
        (outcome.held === 0 ? "" : `; ${outcome.held} unsent message${outcome.held === 1 ? "" : "s"} held for you to retry`)
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

/**
 * Add a contact from whatever was pasted: an invitation link (or its
 * `_oob`) is accepted — the contact by the DID inside, our introduction
 * sent at once — and a DID is added as before.
 */
export async function addContactFrom(input: string, label: string): Promise<Contact | null> {
  const trimmed = input.trim();
  if (trimmed.startsWith("did:")) {
    return addContact(trimmed, label);
  }
  let invitation: Invitation;
  try {
    invitation = parseInvitation(trimmed);
  } catch {
    throw new Error("that is neither a DID (did:…) nor an invitation link");
  }
  return acceptInvitation(invitation, label);
}

export async function acceptInvitation(input: string | Invitation, label: string): Promise<Contact | null> {
  if (agent === null || state.identity === null) {
    return null;
  }
  const invitation = typeof input === "string" ? parseInvitation(input) : input;
  const record = await agent.acceptInvitation(invitation, label);
  upsertContact(state.identity, record);
  if (state.pendingInvitation?.id === invitation.id) {
    state.pendingInvitation = null;
  }
  return state.identity.contacts.find((c) => c.cid === record.cid) ?? null;
}

/** Decline the invitation this page was opened with; nothing is written. */
export function dismissPendingInvitation(): void {
  state.pendingInvitation = null;
}

/** Issue a single-use invitation link: the first person to open it and write becomes a contact. */
export async function createInvitation(): Promise<InvitationView> {
  if (agent === null || state.identity === null) {
    throw new Error("the agent is not running");
  }
  const identity = state.identity;
  const a = agent;
  try {
    const record = await a.createInvitation();
    upsertInvitation(identity, record);
    return invitationView(record);
  } catch (err) {
    // the record may exist unregistered (the mediator could not be told):
    // show it as not ready rather than pretend nothing happened
    for (const record of await a.vault.invitations.all()) {
      upsertInvitation(identity, record);
    }
    throw err;
  }
}

export async function revokeInvitation(id: string): Promise<void> {
  if (agent === null || state.identity === null) {
    return;
  }
  await agent.revokeInvitation(id);
  state.identity.invitations = state.identity.invitations.filter((i) => i.id !== id);
}

/**
 * Send a message of any type to a contact. The agent introduces us on the
 * first message and logs the record; the record comes back through
 * `onMessage` and lands in the views like any other.
 */
export async function send(
  contactDid: string,
  type: string,
  body: Record<string, unknown>,
  options?: SendOptions
): Promise<MessageRecord> {
  if (agent === null) {
    throw new Error("the agent is not running");
  }
  return agent.send(contactDid, type, body, options);
}

/** A line of chat: basicmessage/2.0. */
export async function sendMessage(contactDid: string, text: string): Promise<void> {
  await send(contactDid, BASIC_MESSAGE, { content: text });
}

/**
 * Try again to deliver one message of ours that did not go — failed, or
 * held since a backup brought it in. The outcome lands through
 * `onDelivery` like any other try.
 */
export async function retry(mid: string): Promise<void> {
  if (agent === null) {
    throw new Error("the agent is not running");
  }
  await agent.retry(mid);
}
