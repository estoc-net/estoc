import type { SeedKey } from "@estoc/keystore";
import { base64urlToUtf8 } from "@estoc/did-peer";
import type { DIDDoc, Secret } from "@estoc/did-peer";

import { mintPeerDid, type PeerIdentity } from "./identity/peer.js";
import { chatView, type ChatMessage } from "./protocol/chat.js";
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
import { resolveDid as defaultResolveDid } from "./protocol/resolver.js";
import {
  BASIC_MESSAGE,
  DELIVERY,
  DELIVERY_REQUEST,
  FORWARD,
  LIVE_DELIVERY_CHANGE,
  MEDIATE_GRANT,
  MEDIATE_REQUEST,
  MESSAGES_RECEIVED,
  PROFILE,
  RECIPIENT_UPDATE,
  REQUEST_PROFILE,
  STATUS,
  STATUS_REQUEST,
} from "./protocol/types.js";
import { currentDid, newContact, type ContactRecord } from "./vault/contacts.js";
import { newMessageRecord, type MessageRecord } from "./vault/messages.js";
import { KEY_PUBLIC, type Vault } from "./vault/vault.js";

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
  /** a chat-visible record was appended (sent or received), with its projection */
  onMessage(record: MessageRecord, view: ChatMessage): void;
  /** the agent created or changed a contact (a stranger's first message, a claimed name) */
  onContact(contact: ContactRecord): void;
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
}

interface DeliveryAttachment {
  id?: string;
  data: { base64?: string; json?: unknown };
}

/** The stand-in petname an auto-created contact carries until something names it. */
export function didPlaceholder(did: string): string {
  return did.length <= 30 ? did : `${did.slice(0, 20)}…${did.slice(-6)}`;
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
  private readonly didResolver: { resolve: (did: string) => Promise<DIDDoc | null> };

  private me: PeerIdentity | null = null;
  private pub: PeerIdentity | null = null;
  private mediatorDoc: DIDDoc | null = null;
  private ws: WebSocket | null = null;
  private destroyed = false;
  private _status: AgentStatus = { state: "idle" };
  /** inbound messages already in the log, keyed by proven sender + wire id */
  private seen = new Set<string>();
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
    this.didResolver = { resolve: (did) => this.resolveDid(did) };
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
    return [...(this.me?.secrets ?? []), ...(this.pub?.secrets ?? [])];
  }

  /** The chat projection of everything in the log, in log order. */
  async history(): Promise<ChatMessage[]> {
    const views: ChatMessage[] = [];
    for (const record of await this.vault.messages.read()) {
      const view = chatView(record);
      if (view !== null) {
        views.push(view);
      }
    }
    return views;
  }

  /**
   * Bring the agent up: derive the mediator-facing keys, replay the log's
   * inbound ids for dedup, request mediation on first run, drain the queue,
   * open live delivery. A vault without a mediator stops at `unmediated` —
   * an identity is complete without one; it just cannot be reached yet.
   */
  async start(): Promise<void> {
    try {
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
      for (const record of records) {
        if (record.direction === "in") {
          this.seen.add(dedupKey(record.sender ?? null, record.msg.id));
        }
      }

      this.setStatus({ state: "connecting", detail: "resolving mediator" });
      this.mediatorDoc = await this.resolveDid(mediation.mediatorDid);
      if (this.mediatorDoc === null) {
        throw new Error("mediator DID does not resolve");
      }

      if (this.pub === null) {
        this.setStatus({ state: "connecting", detail: "requesting mediation" });
        await this.establishMediation();
      }

      this.setStatus({ state: "connecting", detail: "picking up queued mail" });
      await this.drainQueue();

      this.setStatus({ state: "connecting", detail: "opening live delivery" });
      this.connectWebSocket();
    } catch (err) {
      this.setStatus({
        state: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Name the mediator for a vault that has none, then start: mediate,
   * mint the public DID, go live. The mediator is chosen after the identity
   * exists, not with it. See `Vault.setMediator` for why only once.
   */
  async setMediator(mediatorDid: string): Promise<void> {
    await this.vault.setMediator(this.seedKey, mediatorDid);
    await this.start();
  }

  destroy(): void {
    this.destroyed = true;
    this.ws?.close();
    this.ws = null;
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

  private async unpack(packed: string): Promise<{ msg: IMessage; sender: string | null }> {
    const [msg, metadata] = await this.didcomm.Message.unpack(
      packed,
      this.didResolver,
      secretsResolverFor(this.allSecrets()),
      {}
    );
    return { msg: msg.as_value(), sender: didOf(metadata.encrypted_from_kid) };
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
   * between is healed by the next start: the grant is idempotent, a key
   * already in the index is reused, and re-adding a recipient is a
   * no_change.
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

    const hasKey = this.vault.keystore.keys.some((entry) => entry.name === KEY_PUBLIC);
    const identity = hasKey
      ? await this.vault.derive(this.seedKey, KEY_PUBLIC)
      : await this.vault.mintKey(this.seedKey, KEY_PUBLIC);
    const pub = mintPeerDid(identity, routingDid);
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
      public: { key: KEY_PUBLIC, did: pub.did },
    };
    await this.vault.saveConfig();
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

  /** The contact who owns `did`, created with a placeholder name if new. */
  private async ensureContact(did: string): Promise<ContactRecord> {
    const existing = await this.vault.contacts.byDid(did);
    if (existing !== null) {
      return existing;
    }
    const contact = newContact(didPlaceholder(did), did);
    await this.vault.contacts.put(contact);
    this.events.onContact?.(contact);
    return contact;
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

      let inner: IMessage;
      let sender: string | null;
      try {
        ({ msg: inner, sender } = await this.unpack(innerPacked));
      } catch (err) {
        this.log(
          `could not open a delivered envelope; leaving it queued: ${err instanceof Error ? err.message : err}`
        );
        continue;
      }

      // Everything from here on is a decision about an opened message, and
      // every decision — including "ignore" — is final for this attachment.
      done();

      if (inner.type === REQUEST_PROFILE) {
        // Someone asked who we are: answer, without asking back — but only
        // someone the envelope proves; an anonymous ask names nobody to
        // answer, and a plaintext `from` is just a claim.
        if (sender === null) {
          this.log("anonymous profile request; ignoring");
          continue;
        }
        try {
          this.log("profile requested; sending ours");
          await this.ensureContact(sender);
          await this.sendProfile(sender, false);
        } catch (err) {
          // Their reply path being down is their problem, not a reason
          // for us to stop reading mail.
          this.log(
            `could not answer a profile request: ${err instanceof Error ? err.message : err}`
          );
        }
        continue;
      }

      if (inner.type !== BASIC_MESSAGE && inner.type !== PROFILE) {
        this.log(`received a ${inner.type ?? "typeless"} message; ignoring`);
        continue;
      }

      const key = dedupKey(sender, inner.id);
      if (this.seen.has(key)) {
        continue;
      }

      // Attribution is the envelope's, never the plaintext's: `from` is
      // whatever the sender typed, and an anonymous (anoncrypt) envelope
      // could carry anyone's DID there. Such a message is still a fact
      // worth logging — with sender null — but it belongs to no contact's
      // thread and cannot rename anyone.
      const counterparty = sender;
      const record = newMessageRecord({
        direction: "in",
        sender,
        msg: inner as unknown as MessageRecord["msg"],
      });
      await this.vault.messages.append(record);
      this.seen.add(key);
      if (counterparty === null) {
        this.log(`logged an anonymous ${inner.type === PROFILE ? "profile" : "message"}; it is attributed to nobody`);
      }

      // A first message from a stranger creates the contact, so it has a
      // thread to land in; the petname is the DID until something names it.
      // An announced displayName is remembered as a claim, and becomes the
      // petname only while the petname is still the placeholder — a name
      // the user typed is never overwritten by what the contact calls
      // themself.
      if (counterparty !== null) {
        const contact = await this.ensureContact(counterparty);
        const view = chatView(record);
        if (view !== null && view.kind === "profile" && view.content !== "") {
          contact.claimedName = view.content;
          if (contact.name === didPlaceholder(currentDid(contact))) {
            contact.name = view.content;
          }
          await this.vault.contacts.put(contact);
          this.events.onContact?.(contact);
        }
      }

      const view = chatView(record);
      if (view !== null) {
        this.events.onMessage?.(record, view);
      }

      const body = inner.body as { send_back_yours?: unknown };
      if (inner.type === PROFILE && body.send_back_yours === true && counterparty !== null) {
        try {
          await this.shareProfileIfNew(counterparty);
        } catch (err) {
          this.log(
            `could not send our profile back: ${err instanceof Error ? err.message : err}`
          );
        }
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
      if (this.destroyed) {
        return;
      }
      this.setStatus({
        state: "connecting",
        detail: "socket closed; reconnecting",
      });
      setTimeout(() => {
        if (!this.destroyed) {
          void this.reconnect();
        }
      }, this.reconnectDelayMs);
    };
  }

  /**
   * Live delivery only pushes what arrives while the socket is up; mail
   * queued during an outage waits for a pickup. So a reconnect drains
   * first, then reopens the socket — and a mediator still unreachable
   * simply fails the drain, and the socket's close reschedules us.
   */
  private async reconnect(): Promise<void> {
    try {
      await this.drainQueue();
    } catch (err) {
      this.log(`pickup on reconnect failed: ${err instanceof Error ? err.message : err}`);
    }
    if (!this.destroyed) {
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
      (this.pub as PeerIdentity).did,
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
    });
    if (!response.ok) {
      throw new Error(`endpoint answered ${response.status}`);
    }
  }

  private async logOutbound(plain: IMessage): Promise<ChatMessage> {
    const record = newMessageRecord({
      direction: "out",
      msg: plain as unknown as MessageRecord["msg"],
    });
    await this.vault.messages.append(record);
    const view = chatView(record) as ChatMessage;
    this.events.onMessage?.(record, view);
    return view;
  }

  async sendBasicMessage(contactDid: string, text: string): Promise<ChatMessage> {
    if (this.pub === null) {
      throw new Error(
        this.vault.config.mediation === null
          ? "no mediator yet — choose one before sending"
          : "no public DID yet — mediation has not completed"
      );
    }
    await this.ensureContact(contactDid);

    // The first message to anyone is preceded by an introduction: our
    // user-profile/1.0 announcement, asking for theirs back.
    await this.shareProfileIfNew(contactDid);

    const plain = plainMessage(BASIC_MESSAGE, this.pub.did, contactDid, {
      content: text,
    });
    await this.deliverToContact(plain, contactDid);
    return this.logOutbound(plain);
  }

  /** Announce our display name once per contact; later renames stay local. */
  private async shareProfileIfNew(contactDid: string): Promise<void> {
    const contact = await this.vault.contacts.byDid(contactDid);
    if (contact?.profileSharedAt !== undefined) {
      return;
    }
    await this.sendProfile(contactDid, true);
  }

  /**
   * Send a user-profile/1.0 `profile` message: the displayName the contact
   * will see is whatever we claim it is — a receiving UI should say as much.
   */
  private async sendProfile(contactDid: string, sendBackYours: boolean): Promise<void> {
    if (this.pub === null) {
      return;
    }
    const plain = plainMessage(PROFILE, this.pub.did, contactDid, {
      profile: { displayName: this.displayName() },
      send_back_yours: sendBackYours,
    });
    await this.deliverToContact(plain, contactDid);

    const contact = await this.vault.contacts.byDid(contactDid);
    if (contact !== null && contact.profileSharedAt === undefined) {
      contact.profileSharedAt = new Date().toISOString();
      await this.vault.contacts.put(contact);
    }
    await this.logOutbound(plain);
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

  async removeContact(cid: string): Promise<void> {
    await this.vault.contacts.remove(cid);
  }
}
