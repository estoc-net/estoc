import type { ContactRecord, MessageRecord } from "@estoc/vault";

import type { PeerVault } from "../identity/vault.js";

/**
 * The seam for application-level protocols — everything between the user
 * and a contact that the DIDComm specification does not itself define:
 * chat, profiles, and whatever an application adds. The agent's part is
 * fixed and the same for every type: open the envelope, attribute it to
 * the DID the envelope proves, log it, home it to a contact, tell the
 * application. A handler adds protocol behaviour on top of that — an
 * answer to send, a contact field to update — and is looked up by message
 * type after the record is already in the log. What a message looks like
 * on screen is not a handler's business; that is the application's
 * projection of the log.
 *
 * `@estoc/agent-core` ships handlers for basicmessage/2.0 and
 * user-profile/1.0; an application registers more through
 * `AgentOptions.handlers`, and one it registers for a type the built-ins
 * cover replaces the built-in.
 */
export interface ProtocolHandler {
  /** the message type URIs this handler speaks */
  types: string[];
  /**
   * A message of one of `types` arrived from a proven sender and was
   * logged and homed to `contact`. Anonymous mail is logged too, but no
   * handler sees it: there is nobody to answer. Throwing here is caught
   * and logged; the message stays handled.
   */
  onInbound?(record: MessageRecord, contact: ContactRecord, agent: HandlerContext): Promise<void>;
  /**
   * The application's first message to a contact is preceded by an
   * introduction; a handler that has one to make (user-profile announces
   * our name) makes it here. Called at most once per contact, before the
   * first `send` to them.
   */
  introduce?(contact: ContactRecord, agent: HandlerContext): Promise<void>;
}

/** Options for one outbound message beyond type and body. */
export interface SendOptions {
  /** the thread this message continues */
  thid?: string;
  /** the parent thread; when unset, the first messages answering an invitation name it */
  pthid?: string;
  attachments?: unknown[];
}

/** What a handler may do through the agent. */
export interface HandlerContext {
  readonly vault: PeerVault;
  /**
   * Compose, deliver and log a message to a contact — the same call the
   * application uses (`Agent.send`), introduction included. Handlers
   * answering inside a protocol usually want `reply` instead.
   */
  send(contactDid: string, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord>;
  /**
   * Compose, deliver and log a message to a contact without any
   * introduction — for a handler's own protocol traffic (a profile in
   * answer to a request, a pong).
   */
  reply(contact: ContactRecord, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord>;
  /** Save a contact the handler changed, and tell the application. */
  saveContact(contact: ContactRecord): Promise<void>;
  /** The name this identity announces about itself. */
  displayName(): string;
  log(line: string): void;
}
