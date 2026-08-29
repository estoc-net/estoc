import type { FolderObject } from "@estoc/folder-object";
import type { ContactRecord, DeliveryEvent, ImportOutcome, InvitationRecord, MessageRecord, TraceEvent, TraceLevel } from "@estoc/vault";
import type { AgentStatus, Invitation, SendOptions, VerifiedShare } from "@estoc/agent-core";

/**
 * The daemon: the agent and its vault, behind one interface the UI talks
 * to and never reaches around. Today it runs in a dedicated worker of the
 * same page (`worker.ts`, reached through `client.ts`); the same
 * interface is what a shared worker, a service worker woken by a push, or
 * a Node process on a laptop would offer — the UI does not know which.
 *
 * Everything that crosses is a plain record or bytes: no vault, no
 * CryptoKey, no agent. The seed is unlocked inside the daemon and stays
 * there; the UI hands a passphrase over and gets screens back.
 */

/**
 * The app's screens, in the order a fresh install meets them:
 * booting → (elsewhere: another tab has the vault) → onboarding (no vault)
 * | locked (a vault, no cached seed) → open.
 */
/**
 * Which screen the vault dictates. `unreachable` is the one phase no
 * daemon says: a client over a socket says it when nothing answers before
 * anything was heard (no daemon there, or no token to show it).
 */
export type Phase = "booting" | "elsewhere" | "onboarding" | "unreadable" | "locked" | "open" | "unreachable";

/** The vault as records, read whole when it opens; the UI projects from here and keeps up by events. */
export interface Snapshot {
  label: string;
  mediatorDid: string | null;
  did: string | null;
  contacts: ContactRecord[];
  invitations: InvitationRecord[];
  messages: MessageRecord[];
  deliveries: DeliveryEvent[];
  /** damaged log lines skipped while reading */
  damaged: number;
}

export interface DaemonEvents {
  /** which screen the vault dictates; `open` comes as `opened`, with the records */
  phase(phase: Phase): void;
  opened(snapshot: Snapshot): void;
  /** the agent's state, and its public DID as of then */
  status(status: AgentStatus, did: string | null): void;
  message(record: MessageRecord, contact: ContactRecord | null): void;
  delivery(event: DeliveryEvent): void;
  /** added or changed: the record; removed: the record, `gone` */
  contact(record: ContactRecord, gone: boolean): void;
  /** issued or taken: the record; revoked: the record, `gone` */
  invitation(record: InvitationRecord, gone: boolean): void;
  log(line: string): void;
}

export interface Daemon {
  /** Take the vault lock and land on the screen the disk dictates (by events). */
  boot(): Promise<void>;
  createIdentity(name: string, passphrase: string): Promise<void>;
  restoreIdentity(zip: Uint8Array, passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  lock(): Promise<void>;
  forgetIdentity(): Promise<void>;
  exportBackup(): Promise<{ name: string; bytes: Uint8Array }>;
  mergeBackup(zip: Uint8Array): Promise<ImportOutcome>;

  /** Name (or change) the mediator; resolves to the public DID after. */
  setMediator(mediatorDid: string): Promise<string | null>;
  addContact(did: string, label: string): Promise<ContactRecord>;
  removeContact(cid: string): Promise<void>;
  acceptInvitation(invitation: Invitation, label: string): Promise<ContactRecord>;
  createInvitation(): Promise<InvitationRecord>;
  revokeInvitation(id: string): Promise<void>;
  send(contactDid: string, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord>;
  shareObject(contactDid: string, object: FolderObject, options: { sign?: boolean; card?: string }): Promise<MessageRecord>;
  fetchPackage(record: MessageRecord): Promise<VerifiedShare>;
  /** a block held in the vault's `blobs/`, by CID */
  blob(cid: string): Promise<Uint8Array | null>;
  retry(mid: string): Promise<void>;

  /**
   * One message's onion: every observation the trace (`@estoc/vault`
   * §6.10) holds around the record `mid` — the frame it rode, each
   * envelope inside, the rituals with mediators — outermost first. Empty
   * when the trace is off, or that part of it is pruned.
   */
  traceOf(mid: string): Promise<TraceEvent[]>;
  /** what this device keeps of what it observes: `off`, `normal`, `verbose` */
  traceLevel(): Promise<TraceLevel>;
  /** Change it for this device, now and for later runs; what a stricter level no longer keeps is pruned at once. */
  setTraceLevel(level: TraceLevel): Promise<TraceLevel>;
}
