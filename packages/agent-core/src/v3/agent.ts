/**
 * The agent is a vault running: one receiver, one dispatcher and a
 * line to each mediator the vault must keep receiving on, over a
 * runtime the host opened and still owns. Opening one recovers and
 * sends nothing. The fold it reads has already judged every proof and
 * listed every piece of unfinished work; the open records what the
 * vault owes on its own over what a crash may have left behind — a
 * one-use invitation's consumption, a peer's acknowledgement — and
 * mints no action: an outbound found waiting, a reply or a
 * notification an earlier input still earns, is listed for the user,
 * who retries, completes or cancels it. Connecting reconciles each
 * arrangement's recipients with its mediator and picks up what it
 * holds, by the ordinary pickup of the account.
 *
 * Only two things here authorize a transport call by themselves: the
 * user's send, and an observation this agent recorded just now. Such
 * a live input, in the call that recorded it, has what the vault owes
 * recorded, then its automatic effects decided and called, then the
 * private-address policy applied; each step stands alone, so that one
 * that fails leaves the others done and the observation recorded all
 * the same. A delivery only told again how it ended is no live input.
 */

import type { DIDDoc } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store/v3";
import { requiredReceivingSet, scanVault, type DidId, type Keys, type MediationId } from "@estoc/vault/v3";

import { LiveInput, type LiveAction } from "./action.js";
import { disclose, didOf, routeOf, type Disclosed, type Disclosure } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { Dispatcher, type DispatcherOptions, type PendingOutbound } from "./dispatcher.js";
import { messageOf, reactTo, type Called, type EffectOptions, type Reacted } from "./effects.js";
import { didcommDocumentOf } from "./evidence.js";
import { effectTypesOf, handlersOf } from "./handlers/index.js";
import { Keyring } from "./keyring.js";
import { MediatorLink } from "./link.js";
import { establish, mediationOf, reconcile, type Established, type Reconciled } from "./mediation.js";
import { Pickup, type Delivered, type Drained, type Fate, type Handle } from "./pickup.js";
import { privateAddress, type PrivateAddress } from "./privacy.js";
import { afterReceipt, recordOwed, type AfterReceipt, type Owed } from "./receive/after.js";
import { receiptOf } from "./receive/receipt.js";
import { Receiver, type Discarded, type Received, type ReceiverOptions, type WaitingDelivery } from "./receive/receiver.js";
import type { PendingWork, Recorder } from "./records.js";
import { resolve } from "./resolver.js";
import { send, type Content, type SendOptions, type Sent, type Target } from "./send.js";
import type { AgentTrace } from "./trace.js";
import { manualProcedures, readRecords, type Manual } from "./views.js";

export interface AgentOptions extends Omit<DispatcherOptions, "links" | "effectTypes" | "trace">, Pick<EffectOptions, "handlers" | "acknowledge">, Pick<ReceiverOptions, "admit" | "maxWaiting" | "maxHeldBytes"> {
  /** the socket live delivery comes down; the global one when left out */
  WebSocket?: typeof WebSocket;
  /** whether a connection opens the socket for live delivery, after its pickup; on by default */
  liveDelivery?: boolean;
  /** whether the first application input to a disclosed address selects a private successor toward its peer: local policy, on by default */
  privateAddresses?: boolean;
  /** the trace over the runtime's local state, which the host opens with the runtime */
  trace: AgentTrace;
  /** told of every delivery once everything that follows it is done */
  onInbound?: (inbound: Inbound) => void;
}

/** A delivery and what followed it; the three steps are null for a delivery that is no live input, and each alone when it threw. */
export interface Inbound {
  received: Received;
  after: AfterReceipt | null;
  reacted: Reacted | null;
  address: PrivateAddress | null;
}

/** How the line to one arrangement's mediator stands. */
export interface Connection {
  mediationId: MediationId;
  /** why the last connection stopped short; null when it ran through */
  unreachable: string | null;
  reconciled: Reconciled | null;
  drained: Drained | null;
  /** whether the socket is open, or opening */
  live: boolean;
}

export interface Submitted extends Sent {
  dispatched: Called;
}

interface Line {
  link: MediatorLink;
  pickup: Pickup;
  connection: Connection;
}

export class Agent {
  private closed = false;

  /** Every manual procedure, each transport call of theirs through this agent's dispatcher. */
  readonly manual: Manual;

  private constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly options: AgentOptions,
    private readonly ring: Keyring,
    private readonly dispatcher: Dispatcher,
    private readonly receiver: Receiver,
    private readonly lines: Map<MediationId, Line>,
    /** what the open recorded of what the vault owed */
    readonly recovered: Owed
  ) {
    this.manual = manualProcedures(runtime, keys, dispatcher, options);
  }

  /** The agent over an open runtime, with networking off; throws `ReceiverInUse` while another agent of the runtime is open. */
  static async open(vault: { runtime: VaultRuntime; keys: Keys }, options: AgentOptions): Promise<Agent> {
    const { runtime, keys } = vault;
    const recovered = await recordOwed(runtime, keys);
    const ring = await Keyring.load(keys, await scanVault(runtime.vault, keys));
    const lines = new Map<MediationId, Line>();
    const dispatcher = new Dispatcher(runtime, keys, { ...options, effectTypes: effectTypesOf(handlersOf(options.handlers)), links: (mediationId) => lines.get(mediationId)?.link ?? null });
    const { didcomm, admit, maxWaiting, maxHeldBytes, trace, log } = options;
    const receiver = new Receiver(runtime, keys, ring, {
      didcomm,
      receipt: receiptOf(runtime, keys),
      acknowledge: async ({ mediationId, deliveryId }) => {
        const line = lines.get(mediationId);
        if (line === undefined) throw new Error(`no line to the mediator of ${mediationId}`);
        await line.pickup.acknowledge([deliveryId]);
      },
      admit,
      maxWaiting,
      maxHeldBytes,
      trace,
      log,
    });
    return new Agent(runtime, keys, options, ring, dispatcher, receiver, lines, recovered);
  }

  /** `open`, then `connect`. */
  static async start(vault: { runtime: VaultRuntime; keys: Keys }, options: AgentOptions): Promise<Agent> {
    const agent = await Agent.open(vault, options);
    await agent.connect();
    return agent;
  }

  /**
   * Every arrangement the vault must keep receiving on, connected:
   * its recipients reconciled with the mediator, what the mediator
   * holds picked up, the socket opened. One that cannot be reached
   * stops none of the others and throws nothing: its connection says
   * why, and connecting again tries it again.
   */
  async connect(): Promise<Connection[]> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const required = [...requiredReceivingSet(fold.mediations, fold.routes)].sort();
    return Promise.all(required.map((mediationId) => this.connectTo(mediationId)));
  }

  /** The arrangement's grant asked for when the fold lacks it, then its connection. Throws what `establish` throws. */
  async establish(mediationId: MediationId): Promise<Established> {
    const line = await this.lineOf(mediationId);
    const established = await establish(line.link, this.runtime, this.keys, mediationId);
    await this.localStateChanged();
    await this.connectTo(mediationId);
    return established;
  }

  /** `disclose` over the line of the arrangement the DID's route is on. */
  async disclose(didId: DidId, disclosure: Disclosure): Promise<Disclosed> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const created = didOf(fold, didId).created;
    const configured = created === null ? null : (routeOf(fold, created.boundRouteId).configured ?? null);
    const link = configured?.kind === "mediated" ? (await this.lineOf(configured.mediationId)).link : null;
    return disclose(link, this.runtime, this.keys, didId, disclosure);
  }

  connections(): Connection[] {
    return [...this.lines.values()].map(({ link, connection }) => ({ ...connection, live: link.live }));
  }

  /** The intent committed, then its one transport call under the action the send minted. */
  async send(target: Target, content: Content, options: SendOptions = {}): Promise<Submitted> {
    this.refuseClosed();
    const sent = await send(this.runtime, this.keys, target, content, options);
    return { ...sent, dispatched: await this.call(sent.action) };
  }

  /** An envelope posted straight to this runtime. */
  async receive(packed: string): Promise<Inbound> {
    return this.follow(await this.receiver.receive({ packed, source: { kind: "direct" } }));
  }

  /**
   * Something the waiting deliveries may wait for changed outside this
   * agent — a DID created, a route configured, an arrangement granted:
   * each one whose wait ended is retried, and followed like any other.
   */
  async localStateChanged(): Promise<Inbound[]> {
    const inbounds: Inbound[] = [];
    for (const received of await this.receiver.localStateChanged()) inbounds.push(await this.follow(received));
    return inbounds;
  }

  records(): Promise<Recorder> {
    return readRecords(this.runtime, this.keys, { handlers: this.options.handlers });
  }

  /** The work an open leaves to the user. */
  async pending(): Promise<PendingWork> {
    return (await this.records()).pending();
  }

  /** Every outbound open to manual action, with the live action this agent still holds for it. */
  outbounds(): Promise<PendingOutbound[]> {
    return this.dispatcher.pending();
  }

  waitingDeliveries(): WaitingDelivery[] {
    return this.receiver.waiting();
  }

  discardedDeliveries(): Discarded[] {
    return this.receiver.discarded();
  }

  /** Nothing is received, called or waited for after this. The runtime stays open: it is its opener's to close. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { link } of this.lines.values()) link.closeSocket();
    this.dispatcher.close();
    this.receiver.close();
  }

  private refuseClosed(): void {
    if (this.closed) throw new Error("the agent is closed");
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private async call(action: LiveAction): Promise<Called> {
    try {
      return await this.dispatcher.run(action);
    } catch (err) {
      const reason = messageOf(err);
      this.log(`the call of ${action.messageId} threw: ${reason}`);
      return { outcome: "threw", messageId: action.messageId, reason };
    }
  }

  private async connectTo(mediationId: MediationId): Promise<Connection> {
    let line: Line;
    try {
      line = await this.lineOf(mediationId);
    } catch (err) {
      return { mediationId, unreachable: messageOf(err), reconciled: null, drained: null, live: false };
    }
    const { link, pickup, connection } = line;
    try {
      connection.reconciled = await reconcile(link, this.runtime, this.keys, mediationId);
      connection.drained = await pickup.drain();
      if ((this.options.liveDelivery ?? true) && !link.live && !this.closed) link.openSocket((opened) => pickup.onFrame(opened));
      connection.unreachable = null;
    } catch (err) {
      connection.unreachable = messageOf(err);
      this.log(`the mediator of ${mediationId} was not reached: ${connection.unreachable}`);
    }
    return { ...connection, live: link.live };
  }

  /** The one line of an arrangement for as long as the agent lives: a link speaks as one account to one mediator. */
  private async lineOf(mediationId: MediationId): Promise<Line> {
    this.refuseClosed();
    const existing = this.lines.get(mediationId);
    if (existing !== undefined) return existing;
    const fold = await scanVault(this.runtime.vault, this.keys);
    const mediation = mediationOf(fold, mediationId);
    if (mediation.me === null || mediation.mediatorDid === null) throw new Error(`the arrangement ${mediationId} has no creation`);
    await this.ring.reload(fold);
    const resolveDid = (did: string): Promise<DIDDoc | null> => this.documentOf(did);
    const mediatorDoc = await resolveDid(mediation.mediatorDid);
    if (mediatorDoc === null) throw new Error(`the mediator ${mediation.mediatorDid} does not resolve`);
    const { didcomm, fetch, WebSocket, trace, timeoutMs, log } = this.options;
    const link = new MediatorLink({ didcomm, resolveDid, fetch, WebSocket, trace, secrets: () => this.ring.secrets(), me: mediation.me.did, mediatorDid: mediation.mediatorDid, mediatorDoc, timeoutMs, log });
    const line: Line = { link, pickup: new Pickup(link, this.handleOf(mediationId), { log }), connection: { mediationId, unreachable: null, reconciled: null, drained: null, live: false } };
    const raced = this.lines.get(mediationId);
    if (raced !== undefined) return raced;
    this.lines.set(mediationId, line);
    return line;
  }

  /** A document for the line's own envelopes — the account's, the mediator's: a long form from itself, a `did:web` over the host's transport, and nothing out of the vault. */
  private async documentOf(did: string): Promise<DIDDoc | null> {
    const answer = await resolve(did, () => null, this.options);
    return answer.outcome === "resolved" ? didcommDocumentOf(answer.resolution) : null;
  }

  /** The receiver's pickup handle, with what follows a delivery run before the mediator is told of it. */
  private handleOf(mediationId: MediationId): Handle {
    const handle = this.receiver.pickupHandle(mediationId);
    const take = async (delivered: Delivered): Promise<Fate> => {
      if ("unreadable" in delivered) return handle(delivered);
      const received = await this.receiver.receive({ packed: delivered.packed, source: { kind: "pickup", mediationId, deliveryId: delivered.attachmentId }, parent: delivered.parent });
      await this.follow(received);
      return received.outcome === "deferred" ? "skip" : "acked";
    };
    return Object.assign(take, { acknowledged: handle.acknowledged });
  }

  private async follow(received: Received): Promise<Inbound> {
    const inbound: Inbound = { received, after: null, reacted: null, address: null };
    if (received.outcome === "received" && received.live) {
      const live = new LiveInput(received.eventId);
      const { handlers, acknowledge, now, trace } = this.options;
      const dispatch = (action: LiveAction): Promise<Dispatched> => this.dispatcher.run(action);
      inbound.after = await this.step("what the vault owes", () => afterReceipt(this.runtime, this.keys, live.eventId, { trace }));
      inbound.reacted = await this.step("the automatic effects", () => reactTo(this.runtime, this.keys, live, { handlers, acknowledge, now, trace, dispatch }));
      if (this.options.privateAddresses ?? true) inbound.address = await this.step("the private address", () => privateAddress(this.runtime, this.keys, live, { now, trace, dispatch }));
    }
    try {
      this.options.onInbound?.(inbound);
    } catch (err) {
      this.log(`the host's inbound listener threw: ${messageOf(err)}`);
    }
    return inbound;
  }

  private async step<T>(what: string, work: () => Promise<T>): Promise<T | null> {
    try {
      return await work();
    } catch (err) {
      this.log(`${what} of a received message failed and is left for manual completion: ${messageOf(err)}`);
      return null;
    }
  }
}
