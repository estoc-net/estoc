import type { SeedKey } from "@estoc/keystore";
import { base64urlToUtf8 } from "@estoc/did-peer";
import type { DIDDoc, Secret } from "@estoc/did-peer";

import { mintPeerDid, type PeerIdentity } from "./identity/peer.js";
import {
  didOf,
  endpointOf,
  ENCRYPTED_MIME,
  PLAIN_TYP,
  plainMessage,
  secretsResolverFor,
  serviceUris,
  type DidcommApi,
  type IMessage,
} from "./protocol/didcomm.js";
import { invitationMessage, parseInvitation, type Invitation } from "./protocol/oob.js";
import { resolveDid as defaultResolveDid } from "./protocol/resolver.js";
import { FORWARD, TRUST_PING, TRUST_PING_RESPONSE, isSpecType } from "./protocol/spec.js";
import {
  DELIVERY,
  DELIVERY_REQUEST,
  LIVE_DELIVERY_CHANGE,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  MESSAGES_RECEIVED,
  RECIPIENT_UPDATE,
  STATUS,
  STATUS_REQUEST,
} from "./protocol/mediation.js";
import type { HandlerContext, ProtocolHandler, SendOptions } from "./protocol/handler.js";
import { BASIC_MESSAGE, basicmessageHandler } from "./protocol/basicmessage.js";
import { userProfileHandler } from "./protocol/user-profile.js";
import {
  DEFAULT_MAX_SHARE_BYTES,
  OBJECT_SHARE,
  attachmentsOf,
  closureOf,
  closureSize,
  objectShareHandler,
  type ObjectShareBody,
} from "./protocol/object-share.js";
import { signRoot, verifyCard, type FolderObject } from "@estoc/folder-object";
import {
  currentDid,
  currentMyDid,
  didPlaceholder,
  previousMyDid,
  newContact,
  type ContactRecord,
  type MyDidUse,
} from "./vault/contacts.js";
import { isOpenInvitation, type InvitationRecord } from "./vault/invitations.js";
import { foldDeliveries, type DeliveryEvent, type DeliveryState } from "./vault/deliveries.js";
import { counterpartyOf, newMessageRecord, type MessageRecord } from "./vault/messages.js";
import { isRelationshipKey, mediationKeyName, type Vault } from "./vault/vault.js";

/**
 * One vault's live agent: mediation, pickup, live delivery, and routing.
 *
 * Packing is deliberately done by hand in two steps — inner authcrypt to the
 * recipient, then an explicit forward sealed anonymously to their mediator —
 * instead of letting didcomm-rust wrap the forward internally. Same wire
 * bytes, but every layer passes through our hands, which keeps the routing
 * DID and the forward's shape ours to decide. The wire behaviour itself
 * (DID shapes, second timestamps, the WebSocket ritual, acking over HTTP)
 * is what mediator-ts pins in its demo-interop test.
 *
 * Everything the agent learns is written to the vault before anyone is
 * told: the log line first, then the event. UIs mirror the vault; they are
 * not the record.
 *
 * Sending is write-first. `send` composes the message, appends it to the
 * log, and only then tries to deliver it; the outcome of that try is a
 * line in the delivery log (`vault.deliveries`), never a change to the
 * message. What is written and not yet delivered is the outbox: it is
 * tried again at every start, whenever the socket to the mediator comes
 * back, and before the next message to the same contact — in order per
 * contact, stopping at the first failure so a conversation never arrives
 * shuffled — and by hand through `retry`. A message written offline is
 * thus a message, not an error; the DIDComm `id` it carries never changes,
 * so a try that reached the far side unnoticed is dropped there as a
 * duplicate. What an import brings in undelivered is held, not tried (see
 * `vault/transfer.ts`).
 *
 * Identity toward contacts is pairwise. The public DID is an address for
 * strangers — a business card — and the first message we send anyone goes
 * out from a did:peer:4 minted for that relationship alone (see
 * `ensurePairwise`). A contact who wrote to the public DID before we had a
 * DID for them is told about the move the DIDComm way: `from_prior`, a JWT
 * the old DID signs over the new one, on every message out until one comes
 * back addressed to the new DID. The same rule carries every later
 * rotation. Inbound, a verified `from_prior` whose issuer we know moves that
 * contact to their new DID; attribution stays the envelope's.
 *
 * The third way to meet is an invitation: a DID minted for nobody yet,
 * handed out as an out-of-band URL, taken by the first person to write to
 * it (see `createInvitation`, `acceptInvitation`, `claimInvitation`). Both
 * sides then hold a DID minted for the other alone, and nothing public was
 * ever exchanged — so no `from_prior` is owed by either.
 *
 * Every DID of ours carries the mediator's routing DID as its service, so
 * changing mediator (`setMediator` on a vault that has one) is a rotation
 * of all of them: the public DID is re-minted after the new grant, every
 * DID toward a contact is re-minted on the new routing DID (`rotateStale`
 * — an invariant checked at every start, so a crash midway heals), open
 * invitations are withdrawn, and each contact we have introduced ourselves
 * to is pinged from the new DID with `from_prior` (`announceMove`), so
 * they move without waiting for our next message. Mail sent to the old
 * DIDs after that lands at the old mediator, which is asked to stop
 * accepting it; the DIDComm rotation is what carries a contact across.
 */

export type AgentStatus =
  | { state: "idle" }
  /** the vault names no mediator: history reads, nothing moves until `setMediator` */
  | { state: "unmediated" }
  | { state: "connecting"; detail: string }
  | { state: "live" }
  | { state: "error"; detail: string };

export interface AgentEvents {
  onStatus(status: AgentStatus): void;
  /**
   * A record was appended to the log (sent or received), with the contact
   * it is homed to through the DID histories — null when the envelope was
   * anonymous or no contact has ever used that DID. What to show of it is
   * the application's projection.
   */
  onMessage(record: MessageRecord, contact: ContactRecord | null): void;
  /**
   * A try at delivering an outbound record ended — sent, or failed with a
   * reason — and the event is in the delivery log. Fold events per `mid`
   * for the message's state (`foldDeliveries`); a record with none is
   * pending.
   */
  onDelivery(event: DeliveryEvent, record: MessageRecord): void;
  /** the agent created or changed a contact (a stranger's first message, a claimed name, a DID minted toward them, a rotation) */
  onContact(contact: ContactRecord): void;
  /** an invitation of ours was issued, taken, or revoked */
  onInvitation(invitation: InvitationRecord): void;
  onLog(line: string): void;
}

export interface AgentOptions {
  vault: Vault;
  seedKey: SeedKey;
  didcomm: DidcommApi;
  events?: Partial<AgentEvents>;
  /** DID resolution; defaults to the package's did:web + did:peer resolver */
  resolveDid?: (did: string) => Promise<DIDDoc | null>;
  /** transports, injectable for tests; default to the globals */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** the name announced over user-profile/1.0; defaults to the vault label */
  displayName?: () => string;
  /** how long to wait before reopening a closed socket */
  reconnectDelayMs?: number;
  /** how long one delivery may take before it counts as failed (and is retried later); default 15s */
  deliveryTimeoutMs?: number;
  /**
   * Application-protocol handlers, added to the built-in basicmessage/2.0
   * and user-profile/1.0 ones; a handler naming a type a built-in covers
   * replaces the built-in for that type.
   */
  handlers?: ProtocolHandler[];
  /**
   * The most block bytes `shareObject` will put in one message; default
   * 1 MiB. Bigger objects wait for another road (see docs/object-share.md).
   */
  maxShareBytes?: number;
}

interface DeliveryAttachment {
  id?: string;
  data: { base64?: string; json?: unknown };
}

/** An envelope opened: the plaintext and what the envelope itself proves. */
interface Opened {
  msg: IMessage;
  /** the DID whose key authenticated the envelope; null when anonymous */
  sender: string | null;
  /** the DID of ours it was sealed to */
  recipient: string | null;
  /** a `from_prior` header didcomm-rust verified: signed by `iss`, naming `sub` */
  fromPrior: { iss: string; sub: string; jwt: string } | null;
}

/**
 * The dedup key of an inbound message: proven sender plus wire id, so one
 * sender's choice of id cannot shadow another's. Anonymous mail keys on the
 * id alone.
 */
function dedupKey(sender: string | null, id: string): string {
  return `${sender ?? ""}\u0000${id}`;
}

export class Agent {
  readonly vault: Vault;
  private readonly seedKey: SeedKey;
  private readonly didcomm: DidcommApi;
  private readonly events: Partial<AgentEvents>;
  private readonly resolveDid: (did: string) => Promise<DIDDoc | null>;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketCtor: typeof WebSocket;
  private readonly displayName: () => string;
  private readonly reconnectDelayMs: number;
  private readonly deliveryTimeoutMs: number;
  private readonly maxShareBytes: number;
  private readonly didResolver: { resolve: (did: string) => Promise<DIDDoc | null> };
  /** application-protocol handlers by message type */
  private readonly handlers = new Map<string, ProtocolHandler>();
  /** the face the handlers see of this agent */
  private readonly handlerContext: HandlerContext;

  private me: PeerIdentity | null = null;
  private pub: PeerIdentity | null = null;
  /**
   * Every DID minted for one relationship, by DID: pairwise ones toward
   * contacts, current or retired, and the ones waiting in open invitations
   * — all of them ours to open mail for.
   */
  private minted = new Map<string, PeerIdentity>();
  private mediatorDoc: DIDDoc | null = null;
  private ws: WebSocket | null = null;
  private destroyed = false;
  /** a start that failed is tried again, later and later — this is the pending try */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startFailures = 0;
  private _status: AgentStatus = { state: "idle" };
  /** inbound messages already in the log, keyed by proven sender + wire id */
  private seen = new Set<string>();
  /** outbound records not yet delivered, by mid; the delivery log's fold decides membership */
  private outbox = new Map<string, MessageRecord>();
  /** the delivery log folded, kept current as events are appended */
  private deliveryStates = new Map<string, DeliveryState>();
  /** outbox passes run one at a time, so two triggers cannot try the same record twice */
  private outboxChain: Promise<unknown> = Promise.resolve();
  /** per-key critical sections (see `locked`) */
  private locks = new Map<string, Promise<unknown>>();
  /**
   * Inbound handling runs one delivery at a time. Socket frames arrive as
   * concurrent async callbacks; two deliveries interleaving would race the
   * dedup check and the log append.
   */
  private inbound: Promise<unknown> = Promise.resolve();

  constructor(options: AgentOptions) {
    this.vault = options.vault;
    this.seedKey = options.seedKey;
    this.didcomm = options.didcomm;
    this.events = options.events ?? {};
    this.resolveDid = options.resolveDid ?? defaultResolveDid;
    // wrapped, not assigned: calling a native fetch with `this` bound to
    // anything but the global is an "Illegal invocation" in browsers
    const fetchImpl = options.fetch ?? fetch;
    this.fetchFn = (input, init) => fetchImpl(input, init);
    this.WebSocketCtor = options.WebSocket ?? WebSocket;
    this.displayName = options.displayName ?? (() => this.vault.config.label);
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? 15_000;
    this.maxShareBytes = options.maxShareBytes ?? DEFAULT_MAX_SHARE_BYTES;
    this.didResolver = { resolve: (did) => this.resolveDid(did) };
    for (const handler of [basicmessageHandler, userProfileHandler, objectShareHandler, ...(options.handlers ?? [])]) {
      for (const type of handler.types) {
        this.handlers.set(type, handler);
      }
    }
    this.handlerContext = {
      vault: this.vault,
      send: (contactDid, type, body, sendOptions) => this.send(contactDid, type, body, sendOptions),
      reply: (contact, type, body, sendOptions) => this.reply(contact, type, body, sendOptions),
      saveContact: (contact) => this.saveContact(contact),
      displayName: () => this.displayName(),
      log: (line) => this.log(line),
    };
  }

  /** The public DID correspondents write to; null until mediation completes. */
  get did(): string | null {
    return this.vault.config.mediation?.public?.did ?? null;
  }

  get status(): AgentStatus {
    return this._status;
  }

  private setStatus(status: AgentStatus): void {
    this._status = status;
    this.events.onStatus?.(status);
  }

  private log(line: string): void {
    this.events.onLog?.(line);
  }

  private allSecrets(): Secret[] {
    const secrets = [...(this.me?.secrets ?? []), ...(this.pub?.secrets ?? [])];
    for (const identity of this.minted.values()) {
      secrets.push(...identity.secrets);
    }
    return secrets;
  }

  /**
   * Run `step` after every earlier step under the same key has finished:
   * how two calls that would each create the same contact, mint the same
   * DID or introduce us twice are made to take turns instead.
   */
  private locked<T>(key: string, step: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(step);
    const parked = run.catch(() => undefined);
    this.locks.set(key, parked);
    void parked.then(() => {
      if (this.locks.get(key) === parked) {
        this.locks.delete(key);
      }
    });
    return run;
  }

  /** Tell the application about a record — homed to its contact when one is known. */
  private async emitMessage(record: MessageRecord): Promise<void> {
    const did = counterpartyOf(record);
    const contact = did === null ? null : await this.vault.contacts.byDid(did);
    this.events.onMessage?.(record, contact);
  }

  /** Save a contact record and tell the application it changed. */
  private async saveContact(contact: ContactRecord): Promise<void> {
    await this.vault.contacts.put(contact);
    this.events.onContact?.(contact);
  }

  /**
   * Bring the agent up: derive the mediator-facing keys, replay the log's
   * inbound ids for dedup, request mediation on first run, drain the queue,
   * open live delivery. A vault without a mediator stops at `unmediated` —
   * an identity is complete without one; it just cannot be reached yet.
   *
   * A start that fails — offline, or the mediator away — reports `error`
   * and tries again by itself, at `reconnectDelayMs` doubling up to a
   * minute, until it comes up or the agent is destroyed: an app opened
   * with no network must not need reopening when the network returns.
   */
  async start(): Promise<void> {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    try {
      // first of all: is this the seed the vault was made from?
      await this.vault.verifyAnchor(this.seedKey);
      const mediation = this.vault.config.mediation;
      if (mediation === null) {
        this.setStatus({ state: "unmediated" });
        return;
      }
      this.setStatus({ state: "connecting", detail: "deriving keys" });
      this.me = await this.vault.peerIdentity(this.seedKey, mediation.me, null);
      if (mediation.public !== null) {
        this.pub = await this.vault.peerIdentity(
          this.seedKey,
          mediation.public,
          mediation.routingDid
        );
      }
      const records = await this.vault.messages.read((damaged) => {
        this.log(`skipping a damaged log line at ${damaged.where}: ${damaged.error}`);
      });
      this.deliveryStates = foldDeliveries(
        await this.vault.deliveries.read((damaged) => {
          this.log(`skipping a damaged delivery line at ${damaged.where}: ${damaged.error}`);
        })
      );
      for (const record of records) {
        if (record.direction === "in") {
          this.seen.add(dedupKey(record.sender ?? null, record.msg.id));
        } else if (this.deliveryStates.get(record.mid)?.status !== "sent") {
          this.outbox.set(record.mid, record);
        }
      }
      await this.loadMinted();

      this.setStatus({ state: "connecting", detail: "resolving mediator" });
      this.mediatorDoc = await this.resolveDid(mediation.mediatorDid);
      if (this.mediatorDoc === null) {
        throw new Error("mediator DID does not resolve");
      }

      if (this.pub === null) {
        this.setStatus({ state: "connecting", detail: "requesting mediation" });
        await this.establishMediation();
      }
      const moved = await this.rotateStale();
      await this.registerPending();
      if (moved.length > 0) {
        this.setStatus({ state: "connecting", detail: "telling contacts about the move" });
        await this.announceMove(moved);
      }

      this.setStatus({ state: "connecting", detail: "picking up queued mail" });
      await this.drainQueue();
      if (this.outbox.size > 0) {
        this.setStatus({ state: "connecting", detail: "sending queued mail" });
        await this.drainOutbox();
      }

      this.setStatus({ state: "connecting", detail: "opening live delivery" });
      this.startFailures = 0;
      this.connectWebSocket();
    } catch (err) {
      this.setStatus({
        state: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
      if (!this.destroyed) {
        const delay = Math.min(this.reconnectDelayMs * 2 ** this.startFailures, 60_000);
        this.startFailures += 1;
        this.startTimer = setTimeout(() => {
          this.startTimer = null;
          if (!this.destroyed) {
            void this.start();
          }
        }, delay);
      }
    }
  }

  /**
   * Name the mediator, then start: mediate, mint the public DID, go live.
   * The mediator is chosen after the identity exists, not with it — and
   * may be changed later, which retires every DID that named the old one
   * (see the class notes): the old mediator is asked to drop them and open
   * invitations are withdrawn here, the vault records the move
   * (`Vault.setMediator`), and `start` mints what the new one calls for.
   */
  async setMediator(mediatorDid: string): Promise<void> {
    const before = this.vault.config.mediation;
    if (before !== null) {
      if (before.mediatorDid === mediatorDid) {
        throw new Error("already reached via that mediator");
      }
      await this.leaveMediator();
    }
    await this.vault.setMediator(this.seedKey, mediatorDid);
    this.me = null;
    this.pub = null;
    this.mediatorDoc = null;
    await this.start();
  }

  /**
   * Leaving a mediator: the socket goes, open invitations are withdrawn
   * (their DIDs would lead mail to the old mediator), and the old mediator
   * is asked — best effort, in one breath — to stop accepting mail for
   * every DID it knew us by, so a message sent to a stale DID fails at the
   * sender rather than queueing where nobody will look.
   */
  private async leaveMediator(): Promise<void> {
    this.closeSocket();
    this.setStatus({ state: "connecting", detail: "leaving the old mediator" });
    const open = (await this.vault.invitations.all()).filter(isOpenInvitation);
    if (this.pub !== null) {
      const dids = new Set<string>([this.pub.did]);
      for (const contact of await this.vault.contacts.all()) {
        for (const use of contact.myDids ?? []) {
          if (isRelationshipKey(use.key) && use.registeredAt !== undefined) {
            dids.add(use.did);
          }
        }
      }
      for (const invitation of open) {
        if (invitation.registeredAt !== undefined) {
          dids.add(invitation.did);
        }
      }
      try {
        await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
          updates: [...dids].map((did) => ({ recipient_did: did, action: "remove" })),
        });
        this.log(`asked the old mediator to drop ${dids.size} DID(s) of ours`);
      } catch (err) {
        this.log(`could not tell the old mediator we are leaving: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const invitation of open) {
      this.minted.delete(invitation.did);
      await this.vault.invitations.remove(invitation.id);
      this.events.onInvitation?.(invitation);
    }
    if (open.length > 0) {
      this.log(`withdrew ${open.length} open invitation link(s); they led to the old mediator`);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.closeSocket();
  }

  /** Close the socket on purpose: its close handler sees it is no longer ours and does not reconnect. */
  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private mediation() {
    return this.vault.config.mediation as NonNullable<Vault["config"]["mediation"]>;
  }

  /**
   * Seal a message from the mediator-facing DID to the mediator itself.
   * Every such request declares the connection it arrives on as its return
   * route — messagepickup 3.0 requires clients to say so explicitly, once
   * per WebSocket and on every HTTP POST.
   */
  private async packForMediator(message: IMessage): Promise<string> {
    const [packed] = await new this.didcomm.Message({
      ...message,
      return_route: "all",
    } as IMessage).pack_encrypted(
      this.mediation().mediatorDid,
      (this.me as PeerIdentity).did,
      null,
      this.didResolver,
      secretsResolverFor(this.allSecrets()),
      { forward: false }
    );
    return packed;
  }

  private mediatorHttp(): string {
    const endpoint = endpointOf(this.mediatorDoc as DIDDoc, "http");
    if (endpoint === null) {
      throw new Error("mediator has no HTTP endpoint");
    }
    return endpoint;
  }

  private async unpack(packed: string): Promise<Opened> {
    const [msg, metadata] = await this.didcomm.Message.unpack(
      packed,
      this.didResolver,
      secretsResolverFor(this.allSecrets()),
      {}
    );
    const value = msg.as_value();
    // the binding hands back null, not undefined, for a header that is not there
    const rotation = metadata.from_prior ?? null;
    return {
      msg: value,
      sender: didOf(metadata.encrypted_from_kid),
      recipient: didOf(metadata.encrypted_to_kids?.[0]),
      fromPrior:
        rotation === null
          ? null
          : { iss: rotation.iss, sub: rotation.sub, jwt: value.from_prior as string },
    };
  }

  /** POST to the mediator and unpack the reply riding the HTTP response. */
  private async mediatorRoundTrip(
    type: string,
    body: Record<string, unknown>
  ): Promise<IMessage> {
    const message = plainMessage(
      type,
      (this.me as PeerIdentity).did,
      this.mediation().mediatorDid,
      body
    );
    const packed = await this.packForMediator(message);
    const response = await this.fetchFn(this.mediatorHttp(), {
      method: "POST",
      headers: { "Content-Type": ENCRYPTED_MIME },
      body: packed,
    });
    if (!response.ok) {
      throw new Error(`mediator answered ${response.status} to ${type}`);
    }
    return (await this.unpack(await response.text())).msg;
  }

  /**
   * mediate-request → grant → mint the public DID on the routing DID →
   * recipient-update. Every step is safe to repeat, so a crash anywhere in
   * between is healed by the next start: the grant is idempotent, the
   * public key's name is fixed by the mediation id so it derives the same
   * DID again, and re-adding a recipient is a no_change.
   */
  private async establishMediation(): Promise<void> {
    const grant = await this.mediatorRoundTrip(MEDIATE_REQUEST, {});
    if (grant.type !== MEDIATE_GRANT) {
      throw new Error(`expected mediate-grant, got ${grant.type}`);
    }
    const routing = grant.body.routing_did as string[] | undefined;
    const routingDid = routing?.[0];
    if (routingDid === undefined) {
      throw new Error("mediate-grant carries no routing_did");
    }
    this.log("mediate-grant received; routing DID is the mediator");

    // the public key of this mediation, named by the mediation's id
    const key = mediationKeyName(this.mediation().id, "public");
    const pub = mintPeerDid(await this.vault.derive(this.seedKey, key), routingDid);
    // The public DID's secrets must be resolvable before anything is
    // sealed to it; the mediator's recipient-update-response is.
    this.pub = pub;

    const updated = await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
      updates: [{ recipient_did: pub.did, action: "add" }],
    });
    const results = updated.body.updated as { result?: string }[] | undefined;
    const result = results?.[0]?.result;
    if (result !== "success" && result !== "no_change") {
      this.pub = null;
      throw new Error("recipient-update was not accepted");
    }

    this.vault.config.mediation = {
      ...this.mediation(),
      routingDid,
      public: { key, did: pub.did },
    };
    await this.vault.saveConfig();
    // the record (config) is written; now the keystore's cache
    await this.vault.mintKey(this.seedKey, key);
    this.log("public DID registered with the mediator");
  }

  /**
   * The pickup loop: status → delivery-request → unpack each → ack, until
   * the queue is empty or a round acks nothing — mail that could not be
   * opened stays queued for a later start (see `processDelivery`), and
   * asking for it again in the same breath would only fetch it again.
   */
  private async drainQueue(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const status = await this.mediatorRoundTrip(STATUS_REQUEST, {});
      const count =
        status.type === STATUS ? (status.body.message_count as number) : 0;
      if (count === 0) {
        return;
      }
      this.log(`${count} message(s) queued at the mediator`);

      const delivery = await this.mediatorRoundTrip(DELIVERY_REQUEST, {
        limit: count,
      });
      if (delivery.type !== DELIVERY) {
        return;
      }
      const acked = await this.enqueueInbound(() => this.processDelivery(delivery));
      if (acked === 0) {
        this.log("nothing in the queue could be handled now; leaving it for a later pickup");
        return;
      }
    }
    this.log("pickup stopped after ten rounds with mail still queued");
  }

  /** Run one inbound step after every earlier one has finished. */
  private enqueueInbound<T>(step: () => Promise<T>): Promise<T> {
    const run = this.inbound.then(step);
    this.inbound = run.catch(() => undefined);
    return run;
  }

  private async ack(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.mediatorRoundTrip(MESSAGES_RECEIVED, { message_id_list: ids });
  }

  /**
   * The contact who owns `did`, created with a placeholder name if new.
   * `addressedAs`, when given, is the DID of ours their envelope was sealed
   * to — remembered so the next message out knows whether they have seen
   * our current DID.
   */
  private ensureContact(did: string, addressedAs?: string | null): Promise<ContactRecord> {
    return this.locked(`contact ${did}`, async () => {
      const existing = await this.vault.contacts.byDid(did);
      if (existing !== null) {
        if (addressedAs && existing.addressedAs !== addressedAs) {
          existing.addressedAs = addressedAs;
          await this.vault.contacts.put(existing);
        }
        return existing;
      }
      const contact = newContact(didPlaceholder(did), did);
      if (addressedAs) {
        contact.addressedAs = addressedAs;
      }
      await this.vault.contacts.put(contact);
      this.events.onContact?.(contact);
      return contact;
    });
  }

  /**
   * A verified `from_prior` from a sender we know by its issuer: the contact
   * moves to the new DID, the old one closes with the JWT as evidence. The
   * envelope must be the new DID's own — a JWT is public once sent, and
   * anyone could replay it under their own key. (didcomm-rust already
   * refuses a plaintext whose `from` is not the JWT's `sub`; comparing
   * against the envelope's proven sender closes the gap between the
   * plaintext's claim and the key that sealed it.)
   */
  private async applyRotation(opened: Opened): Promise<void> {
    const { sender, fromPrior } = opened;
    if (fromPrior === null || sender === null) {
      return;
    }
    if (fromPrior.sub !== sender) {
      this.log(`from_prior names ${didPlaceholder(fromPrior.sub)} but the envelope is from someone else; ignoring the rotation`);
      return;
    }
    const at = new Date().toISOString();
    const contact = await this.vault.contacts.byDid(fromPrior.iss);
    if (contact === null) {
      // A stranger, arriving from a DID minted for us, who signs it over
      // from a DID they used elsewhere (their public one, most likely):
      // the record opens with that DID as its closed first entry, so the
      // day someone pastes it as "Bob" it finds this contact, not a twin.
      if ((await this.vault.contacts.byDid(sender)) !== null) {
        return;
      }
      const stranger = newContact(didPlaceholder(sender), sender);
      stranger.dids = [{ did: fromPrior.iss, from: at, until: at }, { did: sender, from: at, fromPrior: fromPrior.jwt }];
      await this.vault.contacts.put(stranger);
      this.events.onContact?.(stranger);
      this.log("a stranger introduced themself with a DID they used before");
      return;
    }
    if (contact.dids.some((use) => use.did === sender)) {
      return;
    }
    for (const use of contact.dids) {
      if (use.until === undefined) {
        use.until = at;
      }
    }
    contact.dids.push({ did: sender, from: at, fromPrior: fromPrior.jwt });
    await this.vault.contacts.put(contact);
    this.events.onContact?.(contact);
    this.log(`${contact.name} moved to a new DID, vouched for by the old one`);
  }

  /**
   * Mail sealed to a DID that is an invitation of ours: the first person to
   * write takes it — the DID becomes ours toward them, the invitation is
   * marked taken, and their record starts life addressed to it (so no
   * `from_prior` is ever owed). Anyone else writing to a taken invitation
   * is turned away — single-use means single-use, and the URL may have
   * been passed along. Returns false when the message is to be dropped.
   */
  private async claimInvitation(opened: Opened): Promise<boolean> {
    const { sender, recipient } = opened;
    if (recipient === null) {
      return true;
    }
    const invitation = await this.vault.invitations.byDid(recipient);
    if (invitation === null) {
      return true;
    }
    if (sender === null) {
      this.log("an anonymous message to an invitation; ignoring it");
      return false;
    }
    if (invitation.acceptedBy !== undefined) {
      const holder = await this.vault.contacts.byCid(invitation.acceptedBy);
      if (holder !== null && holder.dids.some((use) => use.did === sender)) {
        return true;
      }
      this.log("someone else wrote to an invitation already taken; ignoring them");
      return false;
    }
    const at = new Date().toISOString();
    let contact = await this.vault.contacts.byDid(sender);
    const fresh = contact === null;
    if (contact === null) {
      contact = newContact(didPlaceholder(sender), sender);
    }
    const current = currentMyDid(contact);
    if (current !== null) {
      current.until = at;
    }
    contact.myDids = [
      ...(contact.myDids ?? []),
      {
        did: invitation.did,
        key: invitation.key,
        from: at,
        ...(invitation.registeredAt === undefined ? {} : { registeredAt: invitation.registeredAt }),
      },
    ];
    contact.addressedAs = recipient;
    await this.vault.contacts.put(contact);
    invitation.acceptedBy = contact.cid;
    invitation.acceptedAt = at;
    await this.vault.invitations.put(invitation);
    this.events.onContact?.(contact);
    this.events.onInvitation?.(invitation);
    this.log(
      fresh
        ? "someone took an invitation of ours; they have a thread now"
        : `${contact.name} took an invitation of ours; that DID is ours toward them now`
    );
    return true;
  }

  /**
   * Open the inner envelopes riding a delivery message, log each as a
   * received message, then ack — over HTTP even when the delivery arrived
   * on the socket, which is the ritual the mediator's demo-interop test
   * pins. Returns how many attachments were acked.
   *
   * An attachment is acked once it is dealt with: logged, answered, or
   * ignored on purpose. One that would not open is not — the failure may
   * be a resolver hiccup, and the mediator's copy is the only copy — so it
   * stays queued for the next pickup. Nothing here throws for one bad
   * attachment: the loop moves on, and the ack still goes out for the rest.
   */
  private async processDelivery(delivery: IMessage): Promise<number> {
    const attachments = (delivery.attachments ?? []) as DeliveryAttachment[];
    const acked: string[] = [];

    for (const attachment of attachments) {
      const done = () => {
        if (attachment.id !== undefined) {
          acked.push(attachment.id);
        }
      };
      let innerPacked: string | null = null;
      if (typeof attachment.data.base64 === "string") {
        innerPacked = base64urlToUtf8(attachment.data.base64);
      } else if (attachment.data.json !== undefined) {
        innerPacked = JSON.stringify(attachment.data.json);
      }
      if (innerPacked === null) {
        // nothing inside to open, ever
        done();
        continue;
      }

      let opened: Opened;
      try {
        opened = await this.unpack(innerPacked);
      } catch (err) {
        this.log(
          `could not open a delivered envelope; leaving it queued: ${err instanceof Error ? err.message : err}`
        );
        continue;
      }

      // Everything from here on is a decision about an opened message, and
      // every decision — including "ignore" — is final for this attachment.
      done();
      const { msg: inner, sender, recipient } = opened;
      await this.applyRotation(opened);
      if (!(await this.claimInvitation(opened))) {
        continue;
      }

      const key = dedupKey(sender, inner.id);
      if (this.seen.has(key)) {
        continue;
      }

      // Every message between us and a contact is a fact for the log,
      // whatever its type — the ones the specification defines and the
      // ones an application protocol does. Attribution is the envelope's,
      // never the plaintext's: `from` is whatever the sender typed, and an
      // anonymous (anoncrypt) envelope could carry anyone's DID there.
      // Anonymous mail is logged too — with sender null — but belongs to
      // no contact's thread, cannot rename anyone, and gets no answer.
      const record = newMessageRecord({
        direction: "in",
        sender,
        msg: inner as unknown as MessageRecord["msg"],
      });
      await this.vault.messages.append(record);
      this.seen.add(key);

      if (isSpecType(inner.type)) {
        await this.handleSpecMessage(record, sender);
        continue;
      }

      if (sender === null) {
        this.log(`logged an anonymous ${inner.type} message; it is attributed to nobody`);
        this.events.onMessage?.(record, null);
        continue;
      }

      // A first message from a stranger creates the contact, so it has a
      // thread to land in; the petname is the DID until something names it.
      const contact = await this.ensureContact(sender, recipient);
      this.events.onMessage?.(record, contact);

      const handler = this.handlers.get(inner.type);
      if (handler === undefined) {
        this.log(`received a ${inner.type} message from ${contact.name}; logged, no handler for it`);
        continue;
      }
      if (handler.onInbound === undefined) {
        continue;
      }
      try {
        await handler.onInbound(record, contact, this.handlerContext);
      } catch (err) {
        // A handler that could not answer — the contact's reply path being
        // down, most likely — is their problem, not a reason to stop
        // reading mail. The message is logged and stays handled.
        this.log(`handling a ${inner.type} message from ${contact.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    try {
      await this.ack(acked);
    } catch (err) {
      this.log(
        `ack failed (${err instanceof Error ? err.message : err}); messages stay queued and will be deduplicated on the next pickup`
      );
    }
    return acked.length;
  }

  /**
   * A message in a protocol the specification defines, already logged:
   * trust-ping is answered when asked and the sender is a contact — a
   * stranger's ping names nobody worth confirming our existence to, and
   * makes no contact either: pinging is not writing. A ping-response, an
   * invitation or a forward that reached us as mail are facts with nothing
   * to do.
   */
  private async handleSpecMessage(record: MessageRecord, sender: string | null): Promise<void> {
    const contact = sender === null ? null : await this.vault.contacts.byDid(sender);
    this.events.onMessage?.(record, contact);
    if (record.msg.type !== TRUST_PING) {
      return;
    }
    if (contact === null) {
      this.log(sender === null ? "an anonymous ping; ignoring" : "pinged by someone we do not know; ignoring");
      return;
    }
    this.log(`${contact.name} pinged us`);
    if ((record.msg.body as { response_requested?: unknown }).response_requested === true) {
      try {
        await this.reply(contact, TRUST_PING_RESPONSE, {}, { thid: record.msg.id });
      } catch (err) {
        this.log(`could not answer ${contact.name}'s ping: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private connectWebSocket(): void {
    const wsUri = endpointOf(this.mediatorDoc as DIDDoc, "ws");
    if (wsUri === null) {
      this.setStatus({
        state: "error",
        detail: "mediator has no WebSocket endpoint",
      });
      return;
    }

    const ws = new this.WebSocketCtor(wsUri);
    this.ws = ws;

    ws.onopen = async () => {
      // live-delivery-change is the first frame the socket ever carries.
      try {
        const packed = await this.packForMediator(
          plainMessage(
            LIVE_DELIVERY_CHANGE,
            (this.me as PeerIdentity).did,
            this.mediation().mediatorDid,
            { live_delivery: true }
          )
        );
        ws.send(packed);
      } catch (err) {
        // an unhandled rejection here would leave the socket open and
        // live delivery never switched on; closing it re-enters reconnect
        this.log(`could not open live delivery: ${err instanceof Error ? err.message : err}`);
        ws.close();
      }
    };

    ws.onmessage = async (event: MessageEvent) => {
      const text =
        typeof event.data === "string" ? event.data : await (event.data as Blob).text();
      try {
        const { msg } = await this.unpack(text);
        if (msg.type === STATUS) {
          if (msg.body.live_delivery === true) {
            this.setStatus({ state: "live" });
            this.log("live delivery is on");
          }
          return;
        }
        if (msg.type === DELIVERY) {
          await this.enqueueInbound(() => this.processDelivery(msg));
          return;
        }
        this.log(`unexpected frame type ${msg.type ?? "unknown"}`);
      } catch (err) {
        this.log(
          `could not unpack a socket frame: ${err instanceof Error ? err.message : err}`
        );
      }
    };

    ws.onclose = () => {
      // closed by us (destroy, or a move to another mediator): not ours to reopen
      if (this.destroyed || this.ws !== ws) {
        return;
      }
      this.setStatus({
        state: "connecting",
        detail: "socket closed; reconnecting",
      });
      setTimeout(() => {
        if (!this.destroyed && this.ws === ws) {
          void this.reconnect(ws);
        }
      }, this.reconnectDelayMs);
    };
  }

  /**
   * Live delivery only pushes what arrives while the socket is up; mail
   * queued during an outage waits for a pickup. So a reconnect drains
   * first — the mediator's queue for us, then our outbox, since a socket
   * coming back is the sign the network did — then reopens the socket; a
   * mediator still unreachable simply fails the drain, and the socket's
   * close reschedules us.
   */
  private async reconnect(closed: WebSocket): Promise<void> {
    try {
      await this.drainQueue();
      await this.drainOutbox();
    } catch (err) {
      this.log(`pickup on reconnect failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!this.destroyed && this.ws === closed) {
      this.connectWebSocket();
    }
  }

  /**
   * Pack a plaintext message for a contact layer by layer and POST it:
   * authcrypt to the recipient, then — when they live behind a mediator —
   * a forward request sealed anonymously to that mediator.
   */
  private async deliverToContact(plain: IMessage, contactDid: string): Promise<void> {
    const contactDoc = await this.resolveDid(contactDid);
    if (contactDoc === null) {
      throw new Error("contact DID does not resolve");
    }
    const contactService = serviceUris(contactDoc)[0];
    if (contactService === undefined) {
      throw new Error("contact DID names no service endpoint");
    }

    const [innerPacked] = await new this.didcomm.Message(plain).pack_encrypted(
      contactDid,
      plain.from as string,
      null,
      this.didResolver,
      secretsResolverFor(this.allSecrets()),
      { forward: false }
    );

    let outboundPacked = innerPacked;
    let endpoint: string;

    if (contactService.startsWith("did:")) {
      // The contact lives behind a mediator: wrap a forward and seal it
      // anonymously to that mediator.
      const routingDid = contactService;
      const routingDoc = await this.resolveDid(routingDid);
      const httpEndpoint = routingDoc === null ? null : endpointOf(routingDoc, "http");
      if (httpEndpoint === null) {
        throw new Error("contact's mediator has no HTTP endpoint");
      }

      const forward = {
        id: crypto.randomUUID(),
        typ: PLAIN_TYP,
        type: FORWARD,
        to: [routingDid],
        created_time: Math.floor(Date.now() / 1000),
        body: { next: contactDid },
        attachments: [
          {
            id: crypto.randomUUID(),
            media_type: ENCRYPTED_MIME,
            data: { json: JSON.parse(innerPacked) as unknown },
          },
        ],
      } as IMessage;

      const [outerPacked] = await new this.didcomm.Message(forward).pack_encrypted(
        routingDid,
        null,
        null,
        this.didResolver,
        secretsResolverFor(this.allSecrets()),
        { forward: false }
      );

      outboundPacked = outerPacked;
      endpoint = httpEndpoint;
    } else if (contactService.startsWith("http")) {
      // No mediator in the way — the inner envelope goes straight to them.
      endpoint = contactService;
    } else {
      throw new Error(`unroutable service endpoint: ${contactService}`);
    }

    const response = await this.fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": ENCRYPTED_MIME },
      body: outboundPacked,
      signal: AbortSignal.timeout(this.deliveryTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(`endpoint answered ${response.status}`);
    }
  }

  /** Append an outbound plaintext to the log — into the outbox, until a try delivers it. */
  private async logOutbound(plain: IMessage): Promise<MessageRecord> {
    const record = newMessageRecord({
      direction: "out",
      msg: plain as unknown as MessageRecord["msg"],
    });
    await this.vault.messages.append(record);
    this.outbox.set(record.mid, record);
    await this.emitMessage(record);
    return record;
  }

  /**
   * Compose one message to a contact: from our pairwise DID toward them
   * (minted now if this is the first), to their current DID, with
   * `from_prior` attached while they still know us by another DID. Returns
   * the plaintext, ready for the log; delivery is a separate step.
   */
  private async compose(
    contact: ContactRecord,
    type: string,
    body: Record<string, unknown>,
    options: SendOptions = {}
  ): Promise<IMessage> {
    const from = await this.ensurePairwise(contact);
    const to = currentDid(contact);
    const plain = plainMessage(type, from.did, to, body);
    if (options.thid !== undefined) {
      plain.thid = options.thid;
    }
    if (options.pthid !== undefined) {
      plain.pthid = options.pthid;
    } else if (contact.invitation !== undefined && contact.profileSharedAt === undefined) {
      // answering their invitation: our first messages out — up to and
      // including the introduction — name it, as out-of-band asks
      plain.pthid = contact.invitation;
    }
    if (options.attachments !== undefined) {
      plain.attachments = options.attachments as IMessage["attachments"];
    }
    await this.attachFromPrior(plain, contact);
    return plain;
  }

  /**
   * Compose, log and deliver one message to a contact — no introduction.
   * Resolves once the record is in the log and its first delivery has been
   * tried; the try's outcome is a delivery event, not this promise's — a
   * message the network refused is still a message, waiting in the outbox.
   * Anything already waiting for the same contact goes first, in order.
   */
  private async reply(
    contact: ContactRecord,
    type: string,
    body: Record<string, unknown>,
    options?: SendOptions
  ): Promise<MessageRecord> {
    const plain = await this.compose(contact, type, body, options);
    const record = await this.logOutbound(plain);
    await this.drainOutbox({ cid: contact.cid });
    return record;
  }

  /**
   * One pass over the outbox: every record not yet delivered, oldest
   * first, each tried once — narrowed to one contact or one record when
   * asked. A failure for a contact stops the pass for that contact, so
   * their messages never overtake one another; other contacts go on. Held
   * records (see `vault/deliveries.ts`) are skipped unless named by `mid`
   * — that is what a retry by hand is. Passes are serialised, so a start,
   * a reconnect and a send cannot try one record at the same time.
   */
  private drainOutbox(only: { cid?: string; mid?: string } = {}): Promise<DeliveryEvent[]> {
    const run = this.outboxChain.then(async () => {
      const events: DeliveryEvent[] = [];
      const stalled = new Set<string>();
      for (const mid of [...this.outbox.keys()].sort()) {
        const record = this.outbox.get(mid);
        if (record === undefined || (only.mid !== undefined && mid !== only.mid)) {
          continue;
        }
        if (only.mid === undefined && this.deliveryStates.get(mid)?.status === "held") {
          continue;
        }
        const did = counterpartyOf(record);
        const contact = did === null ? null : await this.vault.contacts.byDid(did);
        if (only.cid !== undefined && contact?.cid !== only.cid) {
          continue;
        }
        if (contact !== null && stalled.has(contact.cid)) {
          continue;
        }
        const event = await this.attemptDelivery(record, contact);
        events.push(event);
        if (event.status !== "sent" && contact !== null) {
          stalled.add(contact.cid);
        }
      }
      return events;
    });
    this.outboxChain = run.catch(() => undefined);
    return run;
  }

  /**
   * One try at delivering a logged record: the mediator is told about the
   * DID it goes from if it has not been yet, the plaintext is sealed to
   * the contact's *current* DID (they may have moved since it was
   * written; the line in the log keeps the address it was written to),
   * and posted. Whatever happens is appended to the delivery log and told
   * to the application; nothing here throws.
   */
  private async attemptDelivery(record: MessageRecord, contact: ContactRecord | null): Promise<DeliveryEvent> {
    const attempt = (this.deliveryStates.get(record.mid)?.attempts ?? 0) + 1;
    let to: string | undefined;
    let event: DeliveryEvent;
    try {
      if (this.pub === null) {
        throw new Error("no public DID yet — mediation has not completed");
      }
      if (contact === null) {
        throw new Error("no contact for the DID this was written to");
      }
      const from = record.msg.from;
      const use = (contact.myDids ?? []).find((candidate) => candidate.did === from);
      if (from === undefined || use === undefined) {
        throw new Error(`the DID this was written from is not one of ours toward ${contact.name}`);
      }
      if (!this.minted.has(from)) {
        throw new Error(`our DID toward ${contact.name} does not derive from this seed`);
      }
      if (use.registeredAt === undefined) {
        await this.registerRecipients([{ contact, use }]);
        this.events.onContact?.(contact);
      }
      to = currentDid(contact);
      await this.deliverToContact(record.msg as unknown as IMessage, to);
      event = { mid: record.mid, at: new Date().toISOString(), status: "sent", attempt, to };
    } catch (err) {
      event = {
        mid: record.mid,
        at: new Date().toISOString(),
        status: "failed",
        attempt,
        error: err instanceof Error ? err.message : String(err),
      };
      if (to !== undefined) {
        event.to = to;
      }
      this.log(`could not deliver ${record.msg.type.split("/").slice(-3).join("/")} (try ${attempt}): ${event.error}`);
    }
    await this.vault.deliveries.append(event);
    this.deliveryStates.set(record.mid, {
      status: event.status,
      attempts: attempt,
      at: event.at,
      ...(event.to !== undefined ? { to: event.to } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    });
    if (event.status === "sent") {
      this.outbox.delete(record.mid);
    }
    this.events.onDelivery?.(event, record);
    return event;
  }

  /**
   * Try everything waiting in the outbox now — what an application calls
   * when it learns the network is back before the socket does (a browser's
   * `online` event). Held records stay held. Resolves when the pass ends.
   */
  async flush(): Promise<void> {
    if (this.pub === null || this.outbox.size === 0) {
      return;
    }
    await this.drainOutbox();
  }

  /**
   * Try again to deliver one message of ours, held or failed — by hand,
   * so a held one is tried too. Resolves to the try's event.
   */
  async retry(mid: string): Promise<DeliveryEvent> {
    const record = this.outbox.get(mid);
    if (record === undefined) {
      throw new Error("that message is not waiting to be sent");
    }
    if (this.pub === null) {
      throw new Error(
        this.vault.config.mediation === null
          ? "no mediator yet — choose one before sending"
          : "no public DID yet — mediation has not completed"
      );
    }
    const [event] = await this.drainOutbox({ mid });
    if (event === undefined) {
      throw new Error("that message is not waiting to be sent");
    }
    return event;
  }

  /**
   * Our DID toward a contact, minted on first use: the mediator's routing
   * DID is its service, and the mediator must accept it as a recipient
   * before anything can come back — which the first delivery attempt
   * from it sees to (`attemptDelivery`), and every start retries. A
   * contact who first reached us at the public DID keeps that as the
   * opening entry of the history, so the rotation away from it has its
   * prior on record.
   */
  private async ensurePairwise(contact: ContactRecord): Promise<PeerIdentity> {
    const routingDid = this.mediation().routingDid;
    if (routingDid === null || this.pub === null) {
      throw new Error("no public DID yet — mediation has not completed");
    }
    const pub = this.pub;
    const use = await this.locked(`mint ${contact.cid}`, async () => {
      const current = currentMyDid(contact);
      if (current !== null) {
        return current;
      }
      if (contact.addressedAs === pub.did && (contact.myDids ?? []).length === 0) {
        contact.myDids = [{ did: pub.did, key: mediationKeyName(this.mediation().id, "public"), from: contact.createdAt }];
      }
      const identity = await this.vault.mintPairwise(this.seedKey, contact, routingDid);
      this.minted.set(identity.did, identity);
      this.log(`minted a DID of our own toward ${contact.name}`);
      // the record gained a DID of ours: tell the UI
      this.events.onContact?.(contact);
      return currentMyDid(contact) as MyDidUse;
    });
    const identity = this.minted.get(use.did);
    if (identity === undefined) {
      throw new Error(`our DID toward ${contact.name} does not derive from this seed`);
    }
    return identity;
  }

  /**
   * recipient-update for pairwise DIDs the mediator has not accepted yet;
   * each contact record is stamped as its DID is accepted.
   */
  private async registerRecipients(
    pending: { contact: ContactRecord; use: MyDidUse }[]
  ): Promise<void> {
    if (pending.length === 0) {
      return;
    }
    const updated = await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
      updates: pending.map(({ use }) => ({ recipient_did: use.did, action: "add" })),
    });
    const results = (updated.body.updated ?? []) as { recipient_did?: string; result?: string }[];
    const at = new Date().toISOString();
    for (const { contact, use } of pending) {
      const result = results.find((r) => r.recipient_did === use.did)?.result;
      if (result !== "success" && result !== "no_change") {
        throw new Error(`the mediator did not accept our DID toward ${contact.name}`);
      }
      use.registeredAt = at;
      await this.vault.contacts.put(contact);
    }
  }

  /**
   * Every DID minted while the mediator could not be told — toward a
   * contact, or in an invitation still open: tell it now.
   */
  private async registerPending(): Promise<void> {
    const pending: { contact: ContactRecord; use: MyDidUse }[] = [];
    for (const contact of await this.vault.contacts.all()) {
      for (const use of contact.myDids ?? []) {
        if (isRelationshipKey(use.key) && use.registeredAt === undefined) {
          pending.push({ contact, use });
        }
      }
    }
    if (pending.length > 0) {
      this.log(`registering ${pending.length} pairwise DID(s) with the mediator`);
      await this.registerRecipients(pending);
    }
    for (const invitation of await this.vault.invitations.all()) {
      if (isOpenInvitation(invitation) && invitation.registeredAt === undefined) {
        await this.registerInvitation(invitation);
      }
    }
  }

  /**
   * Re-derive every DID of ours that appears in a contact's history —
   * pairwise ones, current or since moved on from, and a public DID a
   * mediator change retired (its mail no longer arrives, but a `from_prior`
   * may still have to be signed by it) — and those waiting in open
   * invitations, so their mail can be opened. The current public DID is
   * `pub`, loaded already. A record the seed no longer derives is logged
   * and skipped, not fatal.
   */
  private async loadMinted(): Promise<void> {
    const load = async (ref: { key: string; did: string }, what: string) => {
      if (ref.did === this.pub?.did || this.minted.has(ref.did)) {
        return;
      }
      try {
        const doc = await this.resolveDid(ref.did);
        const service = doc === null ? undefined : serviceUris(doc)[0];
        this.minted.set(ref.did, await this.vault.peerIdentity(this.seedKey, ref, service ?? null));
      } catch (err) {
        this.log(`skipping ${what}: ${err instanceof Error ? err.message : err}`);
      }
    };
    for (const contact of await this.vault.contacts.all()) {
      for (const use of contact.myDids ?? []) {
        await load(use, `our DID toward ${contact.name}`);
      }
    }
    for (const invitation of await this.vault.invitations.all()) {
      if (isOpenInvitation(invitation)) {
        await load(invitation, `the DID of an open invitation (${invitation.id})`);
      }
    }
  }

  /**
   * The invariant a mediator change leaves to `start`: every current DID
   * toward a contact rides the current routing DID. One that rides another
   * — the mediator was changed, whether or not this process saw it — is
   * closed for a fresh one on the new routing DID; the contact is told by
   * `from_prior` on whatever goes out next, starting with `announceMove`.
   * Returns the contacts moved (registration is `registerPending`'s).
   */
  private async rotateStale(): Promise<ContactRecord[]> {
    const routingDid = this.mediation().routingDid;
    if (routingDid === null) {
      return [];
    }
    const moved: ContactRecord[] = [];
    for (const contact of await this.vault.contacts.all()) {
      const use = currentMyDid(contact);
      if (use === null || !isRelationshipKey(use.key)) {
        continue;
      }
      const doc = await this.resolveDid(use.did);
      const service = doc === null ? null : (serviceUris(doc)[0] ?? null);
      if (service === routingDid) {
        continue;
      }
      const identity = await this.vault.mintPairwise(this.seedKey, contact, routingDid);
      this.minted.set(identity.did, identity);
      this.events.onContact?.(contact);
      moved.push(contact);
    }
    if (moved.length > 0) {
      this.log(`minted a fresh DID toward ${moved.length} contact(s); the old ones named the old mediator`);
    }
    return moved;
  }

  /**
   * After a move: a trust-ping (no response asked) to every moved contact
   * we have introduced ourselves to, from the new DID, `from_prior`
   * attached — so they learn the new address now rather than at our next
   * message. Best effort per contact; the next message carries it anyway.
   */
  private async announceMove(moved: ContactRecord[]): Promise<void> {
    for (const stale of moved) {
      const contact = await this.vault.contacts.byCid(stale.cid);
      if (contact === null || contact.profileSharedAt === undefined) {
        continue;
      }
      try {
        const record = await this.reply(contact, TRUST_PING, { response_requested: false });
        if (this.outbox.has(record.mid)) {
          this.log(`could not tell ${contact.name} about our new DID yet; the outbox will`);
        } else {
          this.log(`told ${contact.name} about our new DID`);
        }
      } catch (err) {
        this.log(`could not tell ${contact.name} about our new DID (${err instanceof Error ? err.message : err}); the next message will`);
      }
    }
  }

  /**
   * While a contact last wrote to a DID of ours that is not the one we
   * write from, every message carries `from_prior`: the DID they know
   * signs over the one we use now. Silence on their side is not consent —
   * so it rides along until a reply reaches the new DID. A contact who has
   * never written to us is taken to know us by the public DID — the
   * business card they most likely got our address from — so a first
   * message from a fresh pairwise DID vouches for itself with it, and the
   * other side can tie the two together (see `applyRotation`) — unless we
   * have already written to them from a DID since retired, which is then
   * the one they know. A contact met through their invitation and never
   * written to before is the exception: they minted us a DID and we minted
   * them one, and neither ever knew the other's public DID — there is no
   * prior to vouch with, and no reason to hand them ours.
   */
  private async attachFromPrior(plain: IMessage, contact: ContactRecord): Promise<void> {
    const prior =
      contact.addressedAs ??
      previousMyDid(contact)?.did ??
      (contact.invitation === undefined ? this.pub?.did : undefined);
    const current = plain.from as string;
    if (prior === undefined || prior === current) {
      return;
    }
    const secrets = this.allSecrets();
    if (!secrets.some((secret) => secret.id === `${prior}#key-1`)) {
      this.log(`${contact.name} knows us by a DID this seed does not hold; sending without from_prior`);
      return;
    }
    const [jwt] = await new this.didcomm.FromPrior({
      iss: prior,
      sub: current,
      iat: Math.floor(Date.now() / 1000),
    }).pack(`${prior}#key-1`, this.didResolver, secretsResolverFor(secrets));
    plain.from_prior = jwt;
  }

  /**
   * Send a message of any application protocol to a contact; resolves to
   * the appended log record once its first delivery has been tried —
   * whether that try succeeded is a delivery event (`onDelivery`), not an
   * error here: what could not go now waits in the outbox. Throws only
   * when nothing can be composed at all (no mediator yet). The first
   * message to anyone is preceded by an introduction — every handler that
   * has one to make (user-profile announces our name and asks for theirs)
   * makes it, once per contact.
   */
  async send(
    contactDid: string,
    type: string,
    body: Record<string, unknown>,
    options?: SendOptions
  ): Promise<MessageRecord> {
    if (this.pub === null) {
      throw new Error(
        this.vault.config.mediation === null
          ? "no mediator yet — choose one before sending"
          : "no public DID yet — mediation has not completed"
      );
    }
    let contact = await this.ensureContact(contactDid);
    if (contact.profileSharedAt === undefined) {
      contact = await this.locked(`introduce ${contact.cid}`, async () => {
        // re-read: a send that took its turn before us may have introduced us already
        const current = (await this.vault.contacts.byCid(contact.cid)) as ContactRecord;
        if (current.profileSharedAt === undefined) {
          await this.introduce(current);
        }
        // the introduction may have saved a freshly minted DID on the record
        return (await this.vault.contacts.byCid(contact.cid)) as ContactRecord;
      });
    }
    return this.reply(contact, type, body, options);
  }

  /** Every handler's introduction to a contact not yet introduced to. */
  private async introduce(contact: ContactRecord): Promise<void> {
    for (const handler of new Set(this.handlers.values())) {
      if (handler.introduce !== undefined) {
        await handler.introduce(contact, this.handlerContext);
      }
    }
  }

  /**
   * Share an object (`docs/object-share.md`): hash its canonical tree,
   * put the blocks in our own `blobs/`, and send one object-share/1.0
   * message — the root in the body, one attachment per block. The whole
   * closure goes when it fits `maxShareBytes`; otherwise the minimal
   * share goes — the skeleton and `index.json`, no leaves under
   * `files/`, all or none — and the leaves wait for another road. An
   * object whose minimal share does not fit cannot be shared this way.
   * Plain, the share says only that we handed the object over. With
   * `sign` the anchor signs a card and the share is a signed object we
   * stand behind; with `card` (passing on an object someone else
   * signed) the card must verify and name this very root.
   */
  async shareObject(
    contactDid: string,
    object: FolderObject,
    options: { sign?: boolean; card?: string } = {}
  ): Promise<MessageRecord> {
    const closure = await closureOf(object.tree);
    const { root } = closure;
    let carried = closure.blocks;
    if (closureSize(carried) > this.maxShareBytes) {
      carried = closure.minimal;
      const size = closureSize(carried);
      if (size > this.maxShareBytes) {
        throw new Error(`object's skeleton and index.json are ${size} bytes; one share carries at most ${this.maxShareBytes}`);
      }
    }
    const body: ObjectShareBody = { root };
    if (options.card !== undefined) {
      if (options.sign) {
        throw new Error("a share carries one card: either sign it or pass one on");
      }
      const given = await verifyCard(options.card);
      if (given.root !== root) {
        throw new Error(`the card is about ${given.root}, not this object (${root})`);
      }
      body.card = options.card;
    } else if (options.sign) {
      const anchor = this.vault.config.identity.anchor;
      const identity = await this.vault.derive(this.seedKey, anchor.key);
      body.card = await signRoot(anchor.did, root, identity.signer);
    }
    for (const [cid, bytes] of closure.blocks) {
      await this.vault.blobs.put(cid, bytes);
    }
    return this.send(contactDid, OBJECT_SHARE, body as unknown as Record<string, unknown>, {
      attachments: attachmentsOf(carried),
    });
  }

  /** Send a basicmessage/2.0; resolves to the appended log record. */
  sendBasicMessage(contactDid: string, text: string): Promise<MessageRecord> {
    return this.send(contactDid, BASIC_MESSAGE, { content: text });
  }

  /**
   * Name a contact. A DID that already arrived as a stranger is renamed
   * rather than duplicated; a new DID gets a new record.
   */
  async addContact(did: string, name: string): Promise<ContactRecord> {
    const existing = await this.vault.contacts.byDid(did);
    const contact = existing ?? newContact(name, did);
    contact.name = name;
    await this.vault.contacts.put(contact);
    this.events.onContact?.(contact);
    return contact;
  }

  /**
   * Issue a single-use invitation: a DID minted for whoever answers first,
   * registered with the mediator so their answer has somewhere to land.
   * The record is saved before the mediator is asked, so a registration
   * that fails (offline) is retried at the next start — but the URL is
   * not usable until it succeeds, so the failure is reported, not hidden.
   * `goal` is what the invitation says it is for, in words for the person
   * opening it; the default names us.
   */
  async createInvitation(goal?: string): Promise<InvitationRecord> {
    const routingDid = this.vault.config.mediation?.routingDid ?? null;
    if (routingDid === null || this.pub === null) {
      throw new Error(
        this.vault.config.mediation === null
          ? "no mediator yet — choose one before inviting anyone"
          : "no public DID yet — mediation has not completed"
      );
    }
    const { record, identity } = await this.vault.createInvitation(
      this.seedKey,
      routingDid,
      goal ?? `Write to ${this.displayName()}`
    );
    this.minted.set(identity.did, identity);
    await this.registerInvitation(record);
    this.log("issued an invitation; the first to write to it takes it");
    return record;
  }

  /** recipient-update add for an invitation's DID; the record is stamped — and announced — once the mediator accepts. */
  private async registerInvitation(invitation: InvitationRecord): Promise<void> {
    const updated = await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
      updates: [{ recipient_did: invitation.did, action: "add" }],
    });
    const results = (updated.body.updated ?? []) as { recipient_did?: string; result?: string }[];
    const result = results.find((r) => r.recipient_did === invitation.did)?.result;
    if (result !== "success" && result !== "no_change") {
      throw new Error("the mediator did not accept the invitation's DID");
    }
    invitation.registeredAt = new Date().toISOString();
    await this.vault.invitations.put(invitation);
    this.events.onInvitation?.(invitation);
  }

  /** The invitations this vault has issued, open and taken, oldest first. */
  async invitations(): Promise<InvitationRecord[]> {
    return this.vault.invitations.all();
  }

  /** The message an invitation of ours stands for — what `invitationUrl` encodes. */
  invitationMessage(invitation: InvitationRecord): Invitation {
    return invitationMessage(invitation);
  }

  /**
   * Withdraw an open invitation: the mediator is asked to stop accepting
   * mail for its DID (best effort), and the record goes. A taken invitation
   * is not revoked — its DID is ours toward someone now; forget the
   * contact instead.
   */
  async revokeInvitation(id: string): Promise<void> {
    const invitation = await this.vault.invitations.byId(id);
    if (invitation === null) {
      return;
    }
    if (!isOpenInvitation(invitation)) {
      throw new Error("that invitation was taken; its DID belongs to a contact now");
    }
    if (invitation.registeredAt !== undefined && this.pub !== null) {
      try {
        await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
          updates: [{ recipient_did: invitation.did, action: "remove" }],
        });
      } catch (err) {
        this.log(`could not unregister an invitation's DID: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.minted.delete(invitation.did);
    await this.vault.invitations.remove(id);
    this.events.onInvitation?.(invitation);
    this.log("revoked an invitation");
  }

  /**
   * Accept someone's invitation — a URL, its `_oob` parameter, or the
   * plaintext — under a petname: they become a contact by the DID the
   * invitation names, and we introduce ourselves at once (from a DID
   * minted for them, naming the invitation as `pthid`) so they see us
   * arrive — or, offline, waits in the outbox ahead of our first message.
   * Our own invitations, and a mediator's, are refused.
   */
  async acceptInvitation(input: string | Invitation, name: string): Promise<ContactRecord> {
    const invitation = typeof input === "string" ? parseInvitation(input) : input;
    if (invitation.body.goal_code === "request-mediate") {
      throw new Error("that is a mediator's invitation, not a person's");
    }
    if (this.minted.has(invitation.from) || (await this.vault.invitations.byDid(invitation.from)) !== null) {
      throw new Error("that is an invitation of your own");
    }
    const existing = await this.vault.contacts.byDid(invitation.from);
    const contact = existing ?? newContact(name, invitation.from);
    contact.name = name;
    if (contact.invitation === undefined) {
      contact.invitation = invitation.id;
    }
    await this.vault.contacts.put(contact);
    this.events.onContact?.(contact);
    if (this.pub !== null && contact.profileSharedAt === undefined) {
      try {
        await this.introduce(contact);
      } catch (err) {
        this.log(`could not answer the invitation yet (${err instanceof Error ? err.message : err}); the first message will`);
      }
    }
    return (await this.vault.contacts.byCid(contact.cid)) as ContactRecord;
  }

  /**
   * Forget a contact: the record goes, and the mediator is asked to stop
   * accepting mail for the DIDs we minted toward them (best effort — the
   * keys stay burned in the keystore either way).
   */
  async removeContact(cid: string): Promise<void> {
    const contact = await this.vault.contacts.byCid(cid);
    const pairwise = (contact?.myDids ?? []).filter((use) => isRelationshipKey(use.key));
    if (pairwise.length > 0 && this.pub !== null) {
      try {
        await this.mediatorRoundTrip(RECIPIENT_UPDATE, {
          updates: pairwise.map((use) => ({ recipient_did: use.did, action: "remove" })),
        });
      } catch (err) {
        this.log(`could not unregister our DIDs toward ${contact?.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    for (const use of pairwise) {
      this.minted.delete(use.did);
    }
    await this.vault.contacts.remove(cid);
  }
}
