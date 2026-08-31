/**
 * The seam for application-level protocols — everything between the user
 * and a contact that the DIDComm specification does not itself define:
 * chat, profiles, objects, and whatever an application adds. The agent's
 * part is fixed and the same for every type: open the envelope, prove
 * the sender, record the message, home it to a contact, tell the
 * application. A handler adds protocol behaviour on top of that — an
 * answer to send, an observation to record — and is looked up by message
 * type after the record is already in the log. What a message looks like
 * on screen is not a handler's business; that is the application's
 * projection of the fold.
 *
 * `@estoc/agent-core` ships handlers for basicmessage/2.0,
 * user-profile/1.0 and object-share/1.0; an application registers more
 * through the agent's options, and one it registers for a type the
 * built-ins cover replaces the built-in.
 *
 * Moved from the v1 seam. What changed: a handler no longer holds the
 * vault or saves a contact. It reads the fold and records events — which
 * is all a contact is made of now (vault-events.md §6): what a peer
 * called themself is an observation on the channel the message came by,
 * and the contact's name follows from it at fold time.
 */

import type { BlobStore, Cid } from "@estoc/event-store";
import type { VaultDraft, VaultEvent, VaultFold, VaultType } from "@estoc/vault/v2";

import type { ContactRecord, MessageRecord, PlainMessage } from "./records.js";

/** An inbound message as a handler is shown it: just recorded, its plaintext in hand. */
export type InboundRecord = MessageRecord & { direction: "in"; msg: PlainMessage };

export interface ProtocolHandler {
  /** the message type URIs this handler speaks */
  types: string[];
  /**
   * A message of one of `types` arrived from a proven sender and was
   * recorded and homed to `contact`. Anonymous mail is recorded too, but
   * no handler sees it: there is nobody to answer. Throwing here is
   * caught and logged; the message stays handled.
   */
  onInbound?(record: InboundRecord, contact: ContactRecord, ctx: HandlerContext): Promise<void>;
  /**
   * The application's first message to a contact is preceded by an
   * introduction; a handler that has one to make (user-profile announces
   * our name) makes it here. Called at most once per contact, before the
   * first `send` to them.
   */
  introduce?(contact: ContactRecord, ctx: HandlerContext): Promise<void>;
}

/** Options for one outbound message beyond type and body. */
export interface SendOptions {
  /** the thread this message continues */
  thid?: string;
  /** the parent thread; when unset, the first messages answering an invitation name it */
  pthid?: string;
  attachments?: unknown[];
  /**
   * Roots of blocks the attachments carry, already in `blobs/` — the
   * caller's to have put first — recorded on the message's skeleton
   * (vault-events.md §3.1), as `keepShare` records a received share's.
   */
  roots?: Cid[];
}

/** What a handler may do through the agent. */
export interface HandlerContext {
  /** the vault as it stands: contacts, channels, messages, invitations */
  readonly fold: VaultFold;
  /** the bytes the fold's roots name — a message's plaintext, a shared object's blocks */
  readonly blobs: BlobStore;
  /** Append an event and fold it: a handler's only write. */
  record<T extends VaultType>(draft: VaultDraft<T>): Promise<VaultEvent<T>>;
  /**
   * Compose, record and deliver a message to a contact — the same call
   * the application uses, introduction included. Handlers answering
   * inside a protocol usually want `reply` instead.
   */
  send(cid: string, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord>;
  /**
   * Compose, record and deliver a message to a contact without any
   * introduction — for a handler's own protocol traffic (a profile in
   * answer to a request, a pong). Resolves once the message is recorded;
   * delivery is the outbox's business.
   */
  reply(contact: ContactRecord, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord>;
  /** The name this identity announces about itself. */
  displayName(): string;
  log(line: string): void;
}
