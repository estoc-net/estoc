import { reactive, toRaw } from "vue";
import type { FolderObject } from "@estoc/folder-object";
import {
  counterpartyOf,
  currentDid,
  currentMyDid,
  foldDeliveries,
  type ContactRecord,
  type ImportOutcome,
  type InvitationRecord,
  type MessageRecord,
} from "@estoc/vault";
import {
  BASIC_MESSAGE,
  invitationMessage,
  invitationUrl,
  parseInvitation,
  type Invitation,
  type SendOptions,
  type VerifiedShare,
} from "@estoc/agent-core";

import type { Daemon, Snapshot } from "@estoc/daemon";
import { startDaemon } from "../daemon/client.js";
import { saveFile } from "./backup.js";
import { entryOf } from "./entries.js";
import { isInstalled, setupPwa } from "./pwa.js";
import { isStoragePersisted, persistStorage } from "./storage.js";
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
 * state). The vault and the agent live in the daemon (src/daemon); it
 * reports back through events, which update the views — so the UI
 * renders what the vault holds, never the other way round — and every
 * action here is a call across to it.
 *
 * The passphrase is typed when the identity is created or restored, and
 * again only after "Lock"; the daemon keeps the unlocked seed between
 * sessions. The zip a backup exports carries the seed sealed under that
 * passphrase.
 */

export const state = reactive({
  phase: "booting" as Phase,
  identity: null as Identity | null,
  status: { state: "idle" } as AgentStatus,
  log: [] as string[],
  /** whether the browser has promised not to evict this origin's storage */
  persisted: false,
  /** the socket of an `estoc-daemon` this page is using instead of its own worker; null in the worker */
  daemonAt: null as string | null,
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

let daemon: Daemon | null = null;

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

/** Project the vault's records into views. */
function viewsOf(snapshot: Snapshot): Identity {
  // Threads are keyed by contact, not by DID: a contact's DIDs are a
  // history, and every message is homed through it.
  const cidOf = new Map<string, string>();
  for (const contact of snapshot.contacts) {
    for (const use of contact.dids) {
      cidOf.set(use.did, contact.cid);
    }
  }
  const messages: Entry[] = [];
  for (const record of snapshot.messages) {
    const did = counterpartyOf(record);
    messages.push(entryOf(record, did === null ? null : (cidOf.get(did) ?? null)));
  }
  if (snapshot.damaged > 0) {
    log(`skipped ${snapshot.damaged} damaged line${snapshot.damaged === 1 ? "" : "s"} in the logs`);
  }
  return {
    name: snapshot.label,
    mediatorDid: snapshot.mediatorDid,
    did: snapshot.did,
    contacts: snapshot.contacts.map(contactView),
    invitations: snapshot.invitations.map(invitationView),
    messages,
    deliveries: Object.fromEntries(foldDeliveries(snapshot.deliveries)),
  };
}

/** The daemon's word is the store's state. */
function connectDaemon(): Daemon {
  const started = startDaemon({
    phase(phase) {
      if (phase !== "open") {
        state.identity = null;
      }
      state.phase = phase;
    },
    opened(snapshot) {
      state.identity = viewsOf(snapshot);
      state.phase = "open";
      if (state.daemonAt === null) {
        void isStoragePersisted().then((persisted) => (state.persisted = persisted));
      }
    },
    status(status, did) {
      state.status = status;
      if (state.identity !== null && did !== null) {
        state.identity.did = did;
      }
    },
    message(record, contact) {
      const identity = state.identity;
      if (identity === null || identity.messages.some((m) => m.mid === record.mid)) {
        return;
      }
      identity.messages.push(entryOf(record, contact?.cid ?? null));
    },
    delivery(event) {
      const identity = state.identity;
      if (identity === null) {
        return;
      }
      const prior = identity.deliveries[event.mid];
      identity.deliveries[event.mid] = {
        status: event.status,
        attempts: Math.max(prior?.attempts ?? 0, event.attempt),
        at: event.at,
        ...(event.to === undefined ? {} : { to: event.to }),
        ...(event.error === undefined ? {} : { error: event.error }),
      };
    },
    contact(record, gone) {
      if (state.identity === null) {
        return;
      }
      if (gone) {
        state.identity.contacts = state.identity.contacts.filter((c) => c.cid !== record.cid);
      } else {
        upsertContact(state.identity, record);
      }
    },
    invitation(record, gone) {
      if (state.identity !== null) {
        upsertInvitation(state.identity, record, gone);
      }
    },
    log,
  });
  state.daemonAt = started.where === "worker" ? null : started.where;
  return started.daemon;
}

function running(): Daemon {
  if (daemon === null) {
    throw new Error("the daemon is not running");
  }
  return daemon;
}

/**
 * Bring the app up: the daemon takes the vault lock (or waits for the tab
 * that has it), then lands on the screen the disk dictates — nothing
 * there, a vault without its cached seed, or straight in.
 */
export async function boot(): Promise<void> {
  takePendingInvitation();
  setupPwa({
    onUpdateReady: (apply) => (state.applyUpdate = apply),
    onOfflineReady: () => (state.offlineReady = true),
    onInstallable: (prompt) => (state.install = prompt),
  });
  daemon = connectDaemon();
  await daemon.boot();
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
  await running().createIdentity(name, passphrase);
  state.persisted = state.daemonAt === null ? await persistStorage() : false;
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
  if (state.identity === null) {
    throw new Error("the agent is not running");
  }
  const did = await running().setMediator(mediatorDid);
  state.identity.mediatorDid = mediatorDid;
  state.identity.did = did;
}

/** Restore a backup zip into an empty install, unlocking it with its passphrase. */
export async function restoreIdentity(zip: Uint8Array, passphrase: string): Promise<void> {
  await running().restoreIdentity(zip, passphrase);
  state.persisted = state.daemonAt === null ? await persistStorage() : false;
}

/** The vault is here but its seed is not cached: the passphrase opens it. */
export async function unlock(passphrase: string): Promise<void> {
  await running().unlock(passphrase);
}

/** Forget the cached seed; the vault stays, the passphrase is asked next time. */
export async function lock(): Promise<void> {
  await running().lock();
}

/** Delete the vault and the cached seed. There is nothing to recover afterwards. */
export async function forgetIdentity(): Promise<void> {
  await running().forgetIdentity();
  state.log = [];
}

/** Zip the vault and hand it to the browser as a download. */
export async function downloadBackup(): Promise<void> {
  if (state.identity === null) {
    return;
  }
  const { name, bytes } = await running().exportBackup();
  saveFile(name, bytes);
  log(`exported ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

/** Merge a backup zip into the open vault; the daemon reopens on the merged vault after. */
export async function mergeBackup(zip: Uint8Array): Promise<ImportOutcome> {
  const outcome = await running().mergeBackup(zip);
  if (outcome.kind === "merged") {
    log(
      `merged a backup: ${outcome.messagesAdded} new message${outcome.messagesAdded === 1 ? "" : "s"}, ` +
        `${outcome.contactsAdded} new contact${outcome.contactsAdded === 1 ? "" : "s"}, ` +
        `${outcome.contactsUpdated} updated` +
        (outcome.held === 0 ? "" : `; ${outcome.held} unsent message${outcome.held === 1 ? "" : "s"} held for you to retry`)
    );
  }
  return outcome;
}

export async function addContact(did: string, label: string): Promise<Contact | null> {
  if (state.identity === null) {
    return null;
  }
  // Adding a DID that already arrived as a stranger renames the auto-created
  // contact instead of duplicating it — the agent handles that.
  const record = await running().addContact(did, label);
  upsertContact(state.identity, record);
  return state.identity.contacts.find((c) => c.cid === record.cid) ?? null;
}

export async function removeContact(cid: string): Promise<void> {
  if (state.identity === null) {
    return;
  }
  await running().removeContact(cid);
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
  if (state.identity === null) {
    return null;
  }
  // what crosses to the daemon must be plain: a Vue proxy does not clone
  const invitation = typeof input === "string" ? parseInvitation(input) : toRaw(input);
  const record = await running().acceptInvitation(invitation, label);
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
  if (state.identity === null) {
    throw new Error("the agent is not running");
  }
  // on failure the daemon reports whatever record was left, by event
  const record = await running().createInvitation();
  upsertInvitation(state.identity, record);
  return invitationView(record);
}

export async function revokeInvitation(id: string): Promise<void> {
  if (state.identity === null) {
    return;
  }
  await running().revokeInvitation(id);
  state.identity.invitations = state.identity.invitations.filter((i) => i.id !== id);
}

/**
 * Send a message of any type to a contact. The agent introduces us on the
 * first message and logs the record; the record comes back through the
 * message event and lands in the views like any other.
 */
export async function send(
  contactDid: string,
  type: string,
  body: Record<string, unknown>,
  options?: SendOptions
): Promise<MessageRecord> {
  return running().send(contactDid, type, body, options);
}

/**
 * An object, whole: object-share/1.0. Plain, the share only hands the
 * object over; `sign` makes it a signed object under the anchor; `card`
 * (a signed object passed on) must be about this very object.
 */
export async function shareObject(
  contactDid: string,
  object: FolderObject,
  options: { sign?: boolean; card?: string } = {}
): Promise<void> {
  await running().shareObject(contactDid, toRaw(object), options);
}

/**
 * Fetch the package a partial share names (`docs/object-share.md` §8) and
 * fill the object in from it; resolves to the share as verified after.
 */
export async function fetchPackage(record: MessageRecord): Promise<VerifiedShare> {
  return running().fetchPackage(toRaw(record));
}

/**
 * A block held in the vault's `blobs/`, by CID — what a renderer hands
 * `verifyShare` so leaves that came by any road count as present.
 */
export async function heldBlock(cid: string): Promise<Uint8Array | null> {
  return daemon === null ? null : daemon.blob(cid);
}

/** A line of chat: basicmessage/2.0. */
export async function sendMessage(contactDid: string, text: string): Promise<void> {
  await send(contactDid, BASIC_MESSAGE, { content: text });
}

/**
 * Try again to deliver one message of ours that did not go — failed, or
 * held since a backup brought it in. The outcome lands through the
 * delivery event like any other try.
 */
export async function retry(mid: string): Promise<void> {
  await running().retry(mid);
}
