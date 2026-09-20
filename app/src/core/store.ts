import { shallowReactive, toRaw } from "vue";
import { BASIC_MESSAGE, GOAL_CONNECT, PROFILE, invitationUrl, parseInvitation, type Invitation } from "@estoc/agent-core";
import type { InvitationRecord, TraceLevel } from "@estoc/agent-core/v3";
import type { EventReference, ExecutionId } from "@estoc/vault/v3";
import type { Daemon, Outcome } from "@estoc/daemon/v3";

import { startDaemon } from "../daemon/client.js";
import { forgetSeedKey } from "../daemon/keycache.js";
import { FOLDER_VAULT } from "../daemon/places.js";
import { saveFile } from "./backup.js";
import { conversationsOf } from "./conversations.js";
import { isInstalled, setupPwa } from "./pwa.js";
import { isStoragePersisted, persistStorage } from "./storage.js";
import type { Channel, ContactId, Conversation, Did, DidId, Lines, Merged, MessageId, Phase, Snapshot } from "./types.js";

/**
 * The one store: the vault as the daemon last told it, plus the runtime
 * around it (the lines to the mediators, the activity log, storage and
 * install state). The vault and the agent live in the daemon
 * (src/daemon); every snapshot it sends replaces the one before, whole,
 * so the UI renders what the vault holds and never the other way round,
 * and every action here is a call across to it. The state is reactive
 * one level deep for that reason: a field changes by being replaced, and
 * what it holds stays the plain value that crossed from the daemon, which
 * a call can hand back as it is.
 *
 * The passphrase is typed when the identity is created or restored, and
 * again only after "Lock"; the daemon keeps the unlocked seed between
 * sessions. The file a backup exports carries the seed sealed under that
 * passphrase, and everything else in the clear.
 */

export const state = shallowReactive({
  phase: "booting" as Phase,
  /** what the daemon said with the phase: why a vault is unreadable */
  phaseDetail: null as string | null,
  snapshot: null as Snapshot | null,
  conversations: [] as Conversation[],
  lines: null as Lines | null,
  /** why a daemon over a socket is not answering; null in the worker, and while it answers */
  away: null as string | null,
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
  /** the invitations made since this page opened, by ID, as the links they were handed over as: the vault keeps the disclosure and not what it was said to be for */
  links: {} as Record<string, string>,
  /** what this device keeps of what its agent observes: this copy's own state, never in a backup */
  traceLevel: "normal" as TraceLevel,
});

let daemon: Daemon | null = null;

function log(line: string): void {
  state.log = [...state.log, `${new Date().toLocaleTimeString()}  ${line}`].slice(-200);
}

function said(what: string, { outcome, because }: Outcome): void {
  log(because === null ? `${what}: ${outcome}` : `${what}: ${outcome} (${because})`);
}

function take(snapshot: Snapshot): void {
  state.snapshot = snapshot;
  state.conversations = conversationsOf(snapshot);
}

function connectDaemon(): Daemon {
  const started = startDaemon({
    phase(phase, detail) {
      if (phase !== "open") {
        state.snapshot = null;
        state.conversations = [];
        state.lines = null;
      }
      state.phase = phase;
      state.phaseDetail = detail;
    },
    opened(snapshot) {
      take(snapshot);
      state.phase = "open";
      // the level is the open vault's own local state
      void running().traceLevel().then((level) => (state.traceLevel = level));
      if (state.daemonAt === null) {
        void isStoragePersisted().then((persisted) => (state.persisted = persisted));
      }
    },
    changed: take,
    lines(lines) {
      state.lines = lines;
    },
    away(detail) {
      state.away = detail;
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
 * Bring the app up: the daemon takes the vault's files (or waits for the
 * tab that has them), then lands on the screen they dictate: nothing
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
  // What the dispatcher does on its own timer is told by no event: ask again when the person looks.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.phase === "open") {
      void daemon?.refresh().catch(() => undefined);
    }
  });
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
 * it. No mediator yet: how it is reached is decided afterwards
 * (`chooseMediator`).
 */
export async function createIdentity(name: string, passphrase: string): Promise<void> {
  await running().createIdentity(name, passphrase);
  state.persisted = state.daemonAt === null ? await persistStorage() : false;
}

export async function restoreIdentity(file: Uint8Array, passphrase: string): Promise<void> {
  await running().restoreIdentity(file, passphrase);
  state.persisted = state.daemonAt === null ? await persistStorage() : false;
}

/** The person has read what a restore cannot bring back: sending opens. */
export async function explainedRestore(): Promise<void> {
  await running().explainedRestore();
  await running().refresh();
}

export async function unlock(passphrase: string): Promise<void> {
  await running().unlock(passphrase);
}

/** Forget the cached seed; the vault stays, the passphrase is asked next time. */
export async function lock(): Promise<void> {
  await running().lock();
}

export async function forgetIdentity(): Promise<void> {
  await running().forgetIdentity();
  state.log = [];
  state.links = {};
}

/**
 * Delete the folder-format vault an earlier version left in this
 * browser, with its cached seed, and come up again on what is left.
 * The daemon never touches that folder; the page is what removes it.
 */
export async function discardFolderVault(): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(FOLDER_VAULT, { recursive: true });
  await forgetSeedKey();
  location.reload();
}

export async function downloadBackup(): Promise<void> {
  const { name, bytes } = await running().exportBackup();
  saveFile(name, bytes);
  log(`exported ${name} (${(bytes.length / 1024).toFixed(0)} KB)`);
}

/** Merge a backup file into the open vault; the daemon goes on over the merged vault. */
export async function mergeBackup(file: Uint8Array): Promise<Merged> {
  const merged = await running().mergeBackup(file);
  log(`merged a backup: ${merged.added} new event${merged.added === 1 ? "" : "s"}, ${merged.objects} object${merged.objects === 1 ? "" : "s"}` + (merged.conflicts === 0 ? "" : `, ${merged.conflicts} kept as this vault has them`));
  return merged;
}

export async function chooseMediator(mediatorDid: string): Promise<void> {
  await running().setMediator(mediatorDid);
}

/**
 * The link an invitation is handed over as: this deployment's origin, so
 * tapping it opens an Estoc, the one that issued it or any other; only
 * `_oob` matters to the app that opens it.
 */
function linkOf(invitation: Invitation): string {
  return invitationUrl(`${location.origin}${location.pathname}`, invitation);
}

/** The link of an invitation the vault holds: the one it was made as while this page remembers it, and otherwise one that says the same without what it was for. */
export function invitationLink(record: InvitationRecord): string | null {
  const made = state.links[record.oobId];
  if (made !== undefined) {
    return made;
  }
  if (record.localDid === null) {
    return null;
  }
  return linkOf(
    parseInvitation(
      JSON.stringify({
        type: "https://didcomm.org/out-of-band/2.0/invitation",
        id: record.oobId,
        from: record.localDid,
        body: { goal_code: GOAL_CONNECT, accept: ["didcomm/v2"] },
      })
    )
  );
}

/** A link for one person: whoever opens it and writes first is the one it is for. */
export async function createInvitation(): Promise<string> {
  const { invitation } = await running().createInvitation("one");
  state.links = { ...state.links, [invitation.id]: linkOf(invitation) };
  return invitation.id;
}

function profileOf(snapshot: Snapshot | null): { type: string; body: { profile: { displayName: string } } } {
  return { type: PROFILE, body: { profile: { displayName: snapshot?.label ?? "" } } };
}

/** Say who we are in `channel`: the name this vault goes by, which the peer holds as a claim of ours. */
export async function introduce(channel: Channel): Promise<void> {
  said("introduction", await running().send({ channel }, profileOf(state.snapshot)));
}

/**
 * Accept an invitation under the name we give its issuer: a DID of ours
 * for them alone, a contact that selects the pair, a Ping under the
 * invitation's ID, and our introduction after it.
 */
export async function acceptInvitation(input: string | Invitation, petname: string): Promise<ContactId> {
  // what crosses to the daemon must be plain: a Vue proxy does not clone
  const invitation = typeof input === "string" ? parseInvitation(input) : toRaw(input);
  const accepted = await running().acceptInvitation(invitation, petname);
  said("invitation accepted", accepted);
  if (state.pendingInvitation?.id === invitation.id) {
    state.pendingInvitation = null;
  }
  try {
    await introduce(accepted.channel);
  } catch (err) {
    log(`the introduction was not sent: ${err instanceof Error ? err.message : err}`);
  }
  return accepted.contactId;
}

export function dismissPendingInvitation(): void {
  state.pendingInvitation = null;
}

/** A name of ours for a conversation that has none: a contact that selects its channels. */
export async function nameConversation(channels: Channel[], petname: string): Promise<ContactId> {
  return running().createContact(petname, channels);
}

export async function renameContact(contactId: ContactId, petname: string): Promise<void> {
  await running().renameContact(contactId, petname);
}

export async function deleteContact(contactId: ContactId, options: { block: boolean; erase: boolean }): Promise<void> {
  await running().deleteContact(contactId, {
    ...(options.block ? { block: { includeSuccessors: true } } : {}),
    ...(options.erase ? { erase: "the contact was deleted" } : {}),
  });
}

/** Refuse the channels and whatever their peers move to. */
export async function blockChannels(channels: Channel[]): Promise<void> {
  await running().blockChannels(channels, true);
}

export async function eraseMessage(messageId: MessageId): Promise<void> {
  await running().eraseMessage(messageId);
}

/** A line of chat, to a contact where its channels say which one, or in the channel picked. */
export async function sendMessage(target: { contactId: ContactId } | { channel: Channel; preRotation?: boolean }, text: string): Promise<void> {
  said("sent", await running().send(target, { type: BASIC_MESSAGE, body: { content: text } }));
}

export async function retry(messageId: MessageId): Promise<void> {
  said("retry", await running().retry(messageId));
}

export async function cancel(messageId: MessageId): Promise<void> {
  said("cancel", await running().cancel(messageId));
}

export async function completeResponse(executionId: ExecutionId, effectType: string): Promise<void> {
  said(`reply ${effectType}`, await running().completeResponse(executionId, effectType));
}

export async function completeNotification(rotationEventId: string): Promise<void> {
  said("rotation notification", await running().completeNotification(rotationEventId as EventReference<"did.rotationSelected">));
}

/** A fresh DID of ours toward `peerDid`, in place of `localDidId`, and the peer told. */
export async function rotate(localDidId: DidId, peerDid: Did): Promise<void> {
  said("rotation", await running().rotate(localDidId, peerDid));
}

export async function reconnect(): Promise<void> {
  await running().reconnect();
}

/** Set what this device keeps of what it observes; a stricter level prunes at once. */
export async function setTraceLevel(level: TraceLevel): Promise<void> {
  state.traceLevel = await running().setTraceLevel(level);
}
