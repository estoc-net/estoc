import type { Channel, ContactId, Did, DidId, DisclosureUses, EventReference, ExecutionId, MediationId, MessageId } from "@estoc/vault";
import type {
  ChannelRecord,
  Connection,
  ContactRecord,
  Content,
  Discarded,
  Invitation,
  InvitationRecord,
  PendingWork,
  TraceLevel,
  Unplaced,
  WaitingDelivery,
} from "@estoc/agent-core";

/**
 * The daemon: the agent and its vault, behind one interface the UI
 * talks to and never reaches around. Everything that crosses is a
 * plain record or bytes: no runtime, no key, no agent. The seed is
 * unlocked inside the daemon and stays there; the UI hands a
 * passphrase over and gets screens back.
 */

/**
 * Which screen the vault dictates: booting → (elsewhere: another
 * daemon has the files) → onboarding (no vault) | unreadable | damaged
 * | locked (a vault, no cached seed) → open. `unreachable` is the one
 * phase no daemon says: a client over a socket says it when nothing
 * answers.
 *
 * `damaged` is a vault of this version whose history no longer reads
 * whole, found as it opens or while it runs: it is not run, since it
 * would accept no write, and nothing of it is changed. What the person
 * is owed there: the history comes back only by restoring a validated
 * snapshot into a new vault, as far as that snapshot goes and no
 * further; with no usable snapshot none of it does; the seed is still
 * what the passphrase unlocks from any readable copy of the vault or
 * snapshot. `forgetIdentity` removes the damaged vault to make room.
 */
export type Phase = "booting" | "elsewhere" | "onboarding" | "unreadable" | "damaged" | "locked" | "open" | "unreachable";

/** An arrangement with a mediator, as the fold has it. */
export interface MediationSummary {
  mediationId: MediationId;
  mediatorDid: Did | null;
  selected: boolean;
  usable: boolean;
  retired: string | null;
  faults: string[];
}

/** A communication DID of this vault. */
export interface LocalDidSummary {
  didId: DidId;
  did: Did | null;
  live: boolean;
  retired: string | null;
  disclosed: boolean;
  faults: string[];
}

/** A contact with its channels by pair: the channel records are the snapshot's, each once. */
export interface ContactSummary extends Omit<ContactRecord, "channels"> {
  channels: { channel: Channel; selected: boolean }[];
}

/** The vault as records, read off one fold. The UI projects from here, and takes the next snapshot whole. */
export interface Snapshot {
  /** the did:key the vault's seed derives: the identity every replica of this vault shares */
  anchor: Did;
  label: string;
  /**
   * The vault was restored from a snapshot and the person has not yet
   * been told what a restore cannot bring back. Until `explainedRestore`,
   * no send of the user's and no manual dispatch is made; receiving,
   * reconciling and what the vault owes on its own go on.
   */
  restoreUnexplained: boolean;
  mediations: MediationSummary[];
  dids: LocalDidSummary[];
  contacts: ContactSummary[];
  /** every pair a message or an observation is shown in, and every pair a contact shows */
  channels: ChannelRecord[];
  unplaced: Unplaced;
  invitations: InvitationRecord[];
  pending: PendingWork;
}

/** What only the running agent knows: nothing of it is in the vault. */
export interface Lines {
  connections: Connection[];
  waiting: WaitingDelivery[];
  discarded: Discarded[];
}

export interface DaemonEvents {
  /** which screen the vault dictates; `open` comes as `opened`, with the records */
  phase(phase: Phase, detail: string | null): void;
  opened(snapshot: Snapshot): void;
  /** the vault after something was committed to it */
  changed(snapshot: Snapshot): void;
  lines(lines: Lines): void;
  log(line: string): void;
}

/** What a merge brought, counted: `conflicts` are events under an ID this vault holds with other content, which keeps its own. */
export interface Merged {
  added: number;
  duplicates: number;
  conflicts: number;
  objects: number;
  repaired: number;
  /**
   * The backup and this vault had both written under one replica ID,
   * as two copies of one runtime do, and this one took a fresh ID
   * before the merge went through. Nothing of the history changed.
   */
  renewed: boolean;
}

export interface CreatedInvitation {
  didId: DidId;
  invitation: Invitation;
}

/**
 * What a call came to, in the word of the procedure that made it — a
 * dispatch's `submitted`, `pending`, `failed`, `uncertain`, a
 * completion's `none` — with its reason where it gave one. The vault's
 * own account of the message is in the next snapshot.
 */
export interface Outcome {
  outcome: string;
  because: string | null;
}

export interface SendResult extends Outcome {
  messageId: MessageId;
  channel: Channel;
}

export interface Daemon {
  /** Take the files and land on the screen they dictate (by events). */
  boot(): Promise<void>;
  /**
   * This and the six calls after it, `explainedRestore` apart, work on
   * the daemon's files: they run one at a time in the order asked, and
   * are refused while the phase is `elsewhere`, where the files are
   * another daemon's. One vault is made where none stands; the call
   * that finds one there is refused and removes nothing.
   */
  createIdentity(name: string, passphrase: string): Promise<void>;
  /** A portable snapshot's file restored as this daemon's vault, under the passphrase that opens the snapshot's own wrapped seed. */
  restoreIdentity(snapshot: Uint8Array, passphrase: string): Promise<void>;
  /** The person was shown what a restore cannot bring back: sends and manual dispatch are open from here on. */
  explainedRestore(): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  /** The agent stopped and the seed forgotten, the vault kept hold of; nothing changes for a vault locked already. */
  lock(): Promise<void>;
  /** The vault this daemon holds, removed for good. */
  forgetIdentity(): Promise<void>;
  exportBackup(): Promise<{ name: string; bytes: Uint8Array }>;
  mergeBackup(snapshot: Uint8Array): Promise<Merged>;

  /** An arrangement with `mediatorDid` created, selected and granted, and a route over it configured. */
  setMediator(mediatorDid: string): Promise<MediationId>;
  /** A fresh DID on the selected arrangement's route, disclosed as an out-of-band invitation. */
  createInvitation(uses: DisclosureUses, goal?: string): Promise<CreatedInvitation>;
  /** A fresh DID of ours toward the inviter, a contact that selects the pair, and a Ping under the invitation's ID. */
  acceptInvitation(invitation: Invitation, petname: string): Promise<SendResult & { contactId: ContactId }>;
  createContact(petname: string, channels: Channel[]): Promise<ContactId>;
  renameContact(contactId: ContactId, petname: string): Promise<void>;
  setContactChannels(contactId: ContactId, channels: Channel[]): Promise<void>;
  deleteContact(contactId: ContactId, options?: { block?: { includeSuccessors: boolean }; erase?: string }): Promise<void>;
  blockChannels(channels: Channel[], includeSuccessors: boolean): Promise<void>;
  eraseMessage(messageId: MessageId): Promise<void>;

  send(target: { channel: Channel; preRotation?: boolean } | { contactId: ContactId }, content: Content): Promise<SendResult>;
  retry(messageId: MessageId): Promise<Outcome>;
  cancel(messageId: MessageId): Promise<Outcome>;
  completeResponse(executionId: ExecutionId, effectType: string): Promise<Outcome>;
  completeNotification(rotationEventId: EventReference<"did.rotationSelected">): Promise<Outcome>;
  /** The user's own rotation of `localDidId` toward `peerDid`: a fresh successor, and its notification called. */
  rotate(localDidId: DidId, peerDid: Did): Promise<Outcome & { successor: DidId; existed: boolean }>;

  pending(): Promise<PendingWork>;
  /** The snapshot as of now, to every listener: for what changed with no call of the UI's and no delivery, a retry the dispatcher made on its own. */
  refresh(): Promise<void>;
  /** Every arrangement connected again: reconciled, picked up, live. */
  reconnect(): Promise<void>;

  traceLevel(): Promise<TraceLevel>;
  setTraceLevel(level: TraceLevel): Promise<TraceLevel>;
}
