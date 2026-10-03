/**
 * The agent is a vault running: one receiver, one dispatcher and a
 * line to each mediator the vault must keep receiving on, over a
 * runtime the host opened and still owns. Opening one recovers and
 * sends nothing. The fold it reads has already judged every proof and
 * listed every piece of unfinished work; the open records what the
 * vault owes on its own over what a crash may have left behind — an
 * admission, a peer's acknowledgement — and
 * mints no action: an outbound found waiting, a reply or a
 * notification an earlier input still earns, is listed for the user,
 * who retries, completes or cancels it. Connecting enrolls this
 * runtime in each arrangement — its account registered, the runtime's
 * own replica added — has the account hold every address the
 * arrangement routes, and picks up what waits for the replica. An
 * account holds no queue of its own: its mail waits for each replica,
 * and is picked up, acknowledged and pushed under this runtime's own
 * replica DID. An envelope naming that DID and no communication DID
 * of the vault is no application mail and is acknowledged unopened,
 * since no protocol addressed to a replica is supported.
 *
 * Only two things here authorize a transport call by themselves: the
 * user's send, and the first observation the vault holds of an input,
 * in the call that recorded it and had it admitted under the receipt's
 * lock as the witness its input speaks through. Such a live input has
 * what the vault owes recorded, then the private-address policy and
 * its automatic effects decided, in that order, so that a reply to
 * the input that selected a successor goes from the successor under
 * its proof, then their calls made; each step stands alone, so that
 * one that fails leaves the others done and the observation recorded
 * all the same. A first observation the receipt
 * left waiting for evidence is not live, and stays so: the evidence,
 * whenever and however it comes, admits the observation, and what the
 * input then earns is listed for the user. Over a pickup, the local
 * steps run in the turn the delivery came in, and the calls off it:
 * neither they nor the acknowledgement to the mediator hold the
 * receipt of the delivery behind. An input the vault already held is
 * no live input when it is delivered again, whether this agent
 * recorded it or one before it, and whether or not what it earned was
 * ever sent: it is observed again, what the vault owes is recorded,
 * and a reply it still earns stays listed for the user. Evidence the
 * host recovered outside the agent — an import, a document — is told
 * to it, and what the vault owes over it is recorded then,
 * dispatching nothing.
 */

import type { DIDDoc, Secret } from "@estoc/did-peer";
import type { VaultRuntime } from "@estoc/event-store";
import { authorizedMethodIds, peerResolution, requiredReceivingSet, scanVault, type DidId, type Keys, type MediationId, type Replica } from "@estoc/vault";

import { LiveInput, type LiveAction } from "./action.js";
import { disclose, didOf, routeOf, type Disclosed, type Disclosure } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { Dispatcher, GLOBAL_TIMERS, type DispatcherOptions, type PendingOutbound, type Timers } from "./dispatcher.js";
import { callEffects, decideEffects, messageOf, type Called, type EffectOptions, type Reacted } from "./effects.js";
import { didcommDocumentOf } from "./evidence.js";
import { effectTypesOf, handlersOf } from "./handlers/index.js";
import { Keyring, secretsOf } from "./keyring.js";
import { MediatorLink } from "./link.js";
import { mediationOf } from "./mediation.js";
import { Pickup, type Delivered, type Drained, type Fate, type Handle } from "./pickup.js";
import { callPrivateAddress, decidePrivateAddress, type PrivateAddress } from "./privacy.js";
import { STATUS } from "./protocol/mediation.js";
import { enroll, transientConfirmations, type Confirmations, type Enrolled } from "./replica-enrollment.js";
import { addRecipients, type RecipientsAdded } from "./replica-recipients.js";
import { afterReceipt, type AfterReceipt } from "./receive/after.js";
import { recordOwed, type Owed } from "./reconcile.js";
import { receiptOf } from "./receive/receipt.js";
import { Receiver, type Discarded, type Received, type ReceiverOptions, type WaitingDelivery } from "./receive/receiver.js";
import type { PendingWork, Recorder } from "./records.js";
import { knownLongForms, resolve } from "./resolver.js";
import { send, type Content, type SendOptions, type Sent, type Target } from "./send.js";
import type { AgentTrace } from "./trace.js";
import { manualProcedures, readRecords, type Manual } from "./views.js";

export interface AgentOptions extends Omit<DispatcherOptions, "links" | "effectTypes" | "trace">, Pick<EffectOptions, "handlers" | "acknowledge">, Pick<ReceiverOptions, "admit" | "maxWaiting" | "maxHeldBytes"> {
  /** the socket live delivery comes down; the global one when left out */
  WebSocket?: typeof WebSocket;
  /** whether a connection opens the socket for live delivery, after its pickup; on by default */
  liveDelivery?: boolean;
  /**
   * How live delivery is kept up once a connection wanted it: how long
   * after it was lost, or not reached, the first connection is tried
   * again, and the longest a later one waits, each wait doubling the
   * one before.
   */
  upkeep?: Partial<Upkeep>;
  /** whether the first application input to a disclosed address selects a private successor toward its peer: local policy, on by default */
  privateAddresses?: boolean;
  /** the trace over the runtime's local state, which the host opens with the runtime */
  trace: AgentTrace;
  /** where what a replica-mediation mediator confirmed is kept, the runtime's local options for one; left out, it is kept by this agent alone, and the next one asks again */
  confirmations?: Confirmations;
  /** told of every delivery once everything that follows it is done */
  onInbound?: (inbound: Inbound) => void;
  /** told the lines, whole, once they changed — a connection made or dropped, a pickup ended, a delivery come to wait or discarded — and once for every change of one turn */
  onLines?: (lines: AgentLines) => void;
}

/** The agent's transient records, whole: what `connections()`, `waitingDeliveries()` and `discardedDeliveries()` say. */
export interface AgentLines {
  connections: Connection[];
  waiting: WaitingDelivery[];
  discarded: Discarded[];
}

/** A delivery and what followed it: `after` for every delivery recorded, the other two for a live input alone; each is null where it did not run, or threw. */
export interface Inbound {
  received: Received;
  after: AfterReceipt | null;
  reacted: Reacted | null;
  address: PrivateAddress | null;
}

/** What is left of a delivery once its local work is done: its transport calls, then the host told of it. */
type Finish = () => Promise<Inbound>;

/** How the line to one arrangement's mediator stands. */
export interface Connection {
  mediationId: MediationId;
  /** why the last connection stopped short; null when it ran through */
  unreachable: string | null;
  /** this runtime's enrollment in the arrangement, and what the last connection had to do for it */
  enrolled: Enrolled | null;
  /** the addresses the last connection had the account hold */
  recipients: RecipientsAdded | null;
  drained: Drained | null;
  /** whether the socket is open, or opening */
  live: boolean;
}

export interface Upkeep {
  retryMs: number;
  retryAtMostMs: number;
}

export const UPKEEP: Upkeep = { retryMs: 2_000, retryAtMostMs: 5 * 60_000 };

/** The connection to try again, and how long the next one after it waits. */
interface Retry {
  timer: unknown;
  nextMs: number;
}

export interface Submitted extends Sent {
  dispatched: Called;
}

interface Inbox {
  link: MediatorLink;
  pickup: Pickup;
}

interface Line {
  /** speaks as the arrangement's own DID: its account */
  link: MediatorLink;
  /**
   * The replica's own queue. The account holds none: its mail is picked
   * up as this runtime's replica, over a link of that DID, which there
   * is none of until the vault has the replica's creation.
   */
  inbox: Inbox | null;
  linkAs: (me: string, secrets: () => Secret[]) => MediatorLink;
}

export class Agent {
  private closed = false;
  /** by arrangement, from the first attempt to connect it: one whose line could not even be made has a connection to say why */
  private readonly attempts = new Map<MediationId, Connection>();
  private readonly retries = new Map<MediationId, Retry>();
  /** The latest connection begun for each arrangement: one begun before it changes nothing once it ends. */
  private readonly begun = new Map<MediationId, symbol>();
  /** The socket each arrangement's live delivery is on. */
  private readonly sockets = new Map<MediationId, symbol>();
  /** the calls of the pickup deliveries taken so far, run off their turns and one delivery after another, so the host is told of them in the order the mail came */
  private calling: Promise<void> = Promise.resolve();
  /** whether the host is yet to be told of the lines as they now stand */
  private linesDue = false;

  /** Every manual procedure, each transport call of theirs through this agent's dispatcher. */
  readonly manual: Manual;

  private constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly options: AgentOptions,
    private readonly ring: Keyring,
    private readonly dispatcher: Dispatcher,
    private readonly receiver: Receiver,
    private readonly wires: Map<MediationId, Line>,
    private readonly confirmations: Confirmations,
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
    const confirmations = options.confirmations ?? transientConfirmations();
    const dispatcher = new Dispatcher(runtime, keys, { ...options, confirmations, effectTypes: effectTypesOf(handlersOf(options.handlers)), links: (mediationId) => lines.get(mediationId)?.link ?? null });
    const { didcomm, admit, maxWaiting, maxHeldBytes, trace, log } = options;
    let linesChanged = (): void => undefined;
    const receiver = new Receiver(runtime, keys, ring, {
      didcomm,
      receipt: receiptOf(runtime, keys),
      acknowledge: async ({ mediationId, deliveryId }) => {
        const inbox = lines.get(mediationId)?.inbox ?? null;
        if (inbox === null) throw new Error(`no line to the mediator of ${mediationId}`);
        await inbox.pickup.acknowledge([deliveryId]);
      },
      admit,
      maxWaiting,
      maxHeldBytes,
      trace,
      log,
      changed: () => linesChanged(),
    });
    const agent = new Agent(runtime, keys, options, ring, dispatcher, receiver, lines, confirmations, recovered);
    linesChanged = () => agent.linesChanged();
    return agent;
  }

  /** An agent that fails to connect at all is closed before the failure is thrown: nobody else could close it, and the runtime could have no other. */
  static async start(vault: { runtime: VaultRuntime; keys: Keys }, options: AgentOptions): Promise<Agent> {
    const agent = await Agent.open(vault, options);
    try {
      await agent.connect();
    } catch (err) {
      agent.close();
      throw err;
    }
    return agent;
  }

  /**
   * Every arrangement the vault must keep receiving on, connected:
   * this runtime enrolled, every address held by the account, what
   * waits for the replica picked up, the socket opened. One that
   * cannot be reached stops none of the others and throws nothing: its
   * connection says why, and connecting again tries it again.
   */
  async connect(): Promise<Connection[]> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const required = [...requiredReceivingSet(fold.mediations, fold.dids)].sort();
    return Promise.all(required.map((mediationId) => this.connectTo(mediationId)));
  }

  /**
   * This runtime enrolled in an arrangement: its
   * account registered when the fold has no grant, its own replica
   * added when no confirmation is kept; then the arrangement's
   * connection. Throws what `enroll` throws, and begins no request
   * once the agent is closed.
   */
  async enroll(mediationId: MediationId): Promise<Enrolled> {
    this.refuseClosed();
    const { link } = await this.lineOf(mediationId);
    const enrolled = await enroll(link, this.runtime, this.keys, this.confirmations, mediationId, () => this.refuseClosed());
    this.connectionOf(mediationId).enrolled = enrolled;
    await this.localStateChanged();
    await this.connectTo(mediationId);
    return enrolled;
  }

  /** `disclose` over the line of the arrangement that routes the DID. */
  async disclose(didId: DidId, disclosure: Disclosure): Promise<Disclosed> {
    const fold = await scanVault(this.runtime.vault, this.keys);
    const route = routeOf(didOf(fold, didId));
    const link = route?.kind === "mediated" ? (await this.lineOf(route.mediationId)).link : null;
    return disclose(link, this.runtime, this.keys, didId, disclosure, this.confirmations);
  }

  connections(): Connection[] {
    return [...this.attempts.values()].map((connection) => this.shown(connection));
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
   * The vault's local state changed outside this agent — a DID
   * created, an arrangement granted, evidence imported or a document
   * resolved. What the vault owes over it is
   * recorded first, an admission a proof waited for included, and
   * dispatched by nothing; then each waiting delivery whose wait ended
   * is retried, and followed like any other.
   */
  async localStateChanged(): Promise<Inbound[]> {
    await recordOwed(this.runtime, this.keys);
    const inbounds: Inbound[] = [];
    for (const received of await this.receiver.localStateChanged()) inbounds.push(await this.follow(received));
    return inbounds;
  }

  /** Resolves once the calls of every pickup delivery taken so far are made, or given up on, and the host told; at once when none is running. */
  async settled(): Promise<void> {
    for (let tail = this.calling; ; tail = this.calling) {
      await tail;
      if (tail === this.calling) return;
    }
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

  lines(): AgentLines {
    return { connections: this.connections(), waiting: this.waitingDeliveries(), discarded: this.discardedDeliveries() };
  }

  /**
   * Sockets are closed and waits dropped, and nothing is received or
   * called after this. A connection under way stops at its next step:
   * the request it already made is answered first. The runtime stays
   * open: it is its opener's to close.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const { inbox } of this.wires.values()) inbox?.link.closeSocket();
    for (const mediationId of [...this.retries.keys()]) this.forgetRetry(mediationId);
    this.sockets.clear();
    this.dispatcher.close();
    this.receiver.close();
  }

  private refuseClosed(): void {
    if (this.closed) throw new Error("the agent is closed");
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  /** The host told of the lines once this turn is over, whatever else changes them meanwhile. */
  private linesChanged(): void {
    if (this.linesDue || this.closed || this.options.onLines === undefined) return;
    this.linesDue = true;
    queueMicrotask(() => {
      this.linesDue = false;
      if (this.closed) return;
      try {
        this.options.onLines?.(this.lines());
      } catch (err) {
        this.log(`the host's lines listener threw: ${messageOf(err)}`);
      }
    });
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

  private shown(connection: Connection): Connection {
    return { ...connection, live: this.wires.get(connection.mediationId)?.inbox?.link.live ?? false };
  }

  private connectionOf(mediationId: MediationId): Connection {
    const connection: Connection = this.attempts.get(mediationId) ?? { mediationId, unreachable: null, enrolled: null, recipients: null, drained: null, live: false };
    this.attempts.set(mediationId, connection);
    return connection;
  }

  private async connectTo(mediationId: MediationId): Promise<Connection> {
    const connection = this.connectionOf(mediationId);
    this.linesChanged();
    this.cancelRetry(mediationId);
    const attempt = Symbol();
    this.begun.set(mediationId, attempt);
    const stands = (): boolean => !this.closed && this.begun.get(mediationId) === attempt;
    try {
      const line = await this.lineOf(mediationId);
      const { link } = line;
      const proceed = (): void => {
        if (!stands()) throw new Error("the connection was given up");
      };
      const enrolled = await enroll(link, this.runtime, this.keys, this.confirmations, mediationId, proceed);
      if (!stands()) return this.shown(connection);
      connection.enrolled = enrolled;
      const recipients = await addRecipients(link, this.runtime, this.keys, this.confirmations, mediationId, proceed);
      if (!stands()) return this.shown(connection);
      connection.recipients = recipients;
      const inbox = await this.pickUpAs(mediationId, line, enrolled.replica);
      if (!stands()) return this.shown(connection);
      const drained = await inbox.pickup.drain();
      if (!stands()) return this.shown(connection);
      connection.drained = drained;
      if (this.keepsLive() && !inbox.link.live) this.openSocket(mediationId, inbox);
      connection.unreachable = null;
    } catch (err) {
      if (!stands()) return this.shown(connection);
      connection.unreachable = messageOf(err);
      this.log(`the mediator of ${mediationId} was not reached: ${connection.unreachable}`);
      this.retryLater(mediationId);
    }
    this.linesChanged();
    return this.shown(connection);
  }

  /**
   * What reached the mediator between the pickup and live delivery
   * coming on was queued without being pushed: it is picked up once the
   * mediator says live delivery is on. A frame is handled after it was
   * opened, which a socket does not wait for before it closes: the
   * status of a socket that is gone says nothing of the one that
   * followed it.
   */
  private openSocket(mediationId: MediationId, { link, pickup }: Inbox): void {
    const socket = Symbol();
    this.sockets.set(mediationId, socket);
    link.openSocket(
      (opened) => {
        if (this.sockets.get(mediationId) === socket && opened.msg.type === STATUS && opened.msg.body["live_delivery"] === true) void this.pickUpOnceLive(mediationId, pickup);
        return pickup.onFrame(opened);
      },
      () => {
        if (this.sockets.get(mediationId) === socket) this.sockets.delete(mediationId);
        this.linesChanged();
        this.log(`live delivery was lost for ${mediationId}`);
        this.retryLater(mediationId);
      }
    );
  }

  private keepsLive(): boolean {
    return (this.options.liveDelivery ?? true) && !this.closed;
  }

  private timers(): Timers {
    return this.options.timers ?? GLOBAL_TIMERS;
  }

  private upkeep(): Upkeep {
    return { ...UPKEEP, ...this.options.upkeep };
  }

  private cancelRetry(mediationId: MediationId): void {
    const retry = this.retries.get(mediationId);
    if (retry === undefined || retry.timer === null) return;
    this.timers().clear(retry.timer);
    retry.timer = null;
  }

  private forgetRetry(mediationId: MediationId): void {
    this.cancelRetry(mediationId);
    this.retries.delete(mediationId);
  }

  /**
   * The connection tried again after a wait, each wait twice the one
   * before until live delivery comes on. The wait is shortened by up to
   * half, at random, so that the accounts a mediator dropped together
   * do not come back together.
   */
  private retryLater(mediationId: MediationId): void {
    if (!this.keepsLive()) return;
    const { retryMs, retryAtMostMs } = this.upkeep();
    const retry = this.retries.get(mediationId) ?? { timer: null, nextMs: retryMs };
    this.retries.set(mediationId, retry);
    if (retry.timer !== null) return;
    const wait = retry.nextMs * (0.5 + Math.random() / 2);
    retry.nextMs = Math.min(retry.nextMs * 2, retryAtMostMs);
    retry.timer = this.timers().set(() => {
      retry.timer = null;
      void this.retry(mediationId, retry);
    }, wait);
  }

  /** A connection begun, or live delivery come on, while the vault was being read leaves this try nothing to do. */
  private async retry(mediationId: MediationId, retry: Retry): Promise<void> {
    if (!this.keepsLive()) return;
    const latest = this.begun.get(mediationId);
    const stands = (): boolean => !this.closed && this.begun.get(mediationId) === latest && this.retries.get(mediationId) === retry;
    try {
      const fold = await scanVault(this.runtime.vault, this.keys);
      if (!stands()) return;
      if (!requiredReceivingSet(fold.mediations, fold.dids).has(mediationId)) return;
    } catch (err) {
      if (!stands()) return;
      this.log(`the connection of ${mediationId} was not tried again: ${messageOf(err)}`);
      this.retryLater(mediationId);
      return;
    }
    await this.connectTo(mediationId);
  }

  private async pickUpOnceLive(mediationId: MediationId, pickup: Pickup): Promise<void> {
    if (this.closed) return;
    this.forgetRetry(mediationId);
    try {
      const drained = await pickup.drain();
      const connection = this.attempts.get(mediationId);
      if (connection !== undefined) connection.drained = drained;
      this.linesChanged();
    } catch (err) {
      this.log(`the pickup once live delivery came on failed for ${mediationId}: ${messageOf(err)}`);
    }
  }

  /** The one line of an arrangement for as long as the agent lives: a link speaks as one account to one mediator. */
  private async lineOf(mediationId: MediationId): Promise<Line> {
    this.refuseClosed();
    const existing = this.wires.get(mediationId);
    if (existing !== undefined) return existing;
    const fold = await scanVault(this.runtime.vault, this.keys);
    const mediation = mediationOf(fold, mediationId);
    if (mediation.me === null || mediation.mediatorDid === null) throw new Error(`the arrangement ${mediationId} has no creation`);
    await this.ring.reload(fold);
    // The mediator may answer under its short form: the long form it was arranged under is in the fold, and an arrangement's creation never changes.
    const known = knownLongForms(fold);
    const resolveDid = async (did: string): Promise<DIDDoc | null> => {
      const answer = await resolve(did, known, this.options);
      return answer.outcome === "resolved" ? didcommDocumentOf(answer.resolution) : null;
    };
    const mediatorDoc = await resolveDid(mediation.mediatorDid);
    if (mediatorDoc === null) throw new Error(`the mediator ${mediation.mediatorDid} does not resolve`);
    const { didcomm, fetch, WebSocket, trace, timeoutMs, log } = this.options;
    const { mediatorDid } = mediation;
    const linkAs = (me: string, secrets: () => Secret[]): MediatorLink => new MediatorLink({ didcomm, resolveDid, fetch, WebSocket, trace, secrets, me, mediatorDid, mediatorDoc, timeoutMs, log });
    const link = linkAs(mediation.me.did, () => this.ring.secrets());
    const line: Line = { link, inbox: null, linkAs };
    const raced = this.wires.get(mediationId);
    if (raced !== undefined) return raced;
    this.wires.set(mediationId, line);
    return line;
  }

  /**
   * The line's queue made the replica's own, once: a link speaking as
   * the replica's DID with that DID's keys alone, under both its
   * spellings, since the mediator seals what it pushes to the short
   * form. A replica's binding never changes, so neither does the link.
   */
  private async pickUpAs(mediationId: MediationId, line: Line, replica: Replica): Promise<Inbox> {
    if (line.inbox !== null) return line.inbox;
    const { did, longFormDid } = replica;
    if (did === null || longFormDid === null) throw new Error(`the replica ${replica.replicaId} has no DID to pick up as`);
    const { document } = peerResolution(longFormDid);
    const secrets = secretsOf(await this.keys.replicaKeys(replica.replicaId), [longFormDid, did], { authentication: authorizedMethodIds(document, "authentication"), keyAgreement: authorizedMethodIds(document, "keyAgreement") });
    if (line.inbox !== null) return line.inbox;
    const link = line.linkAs(longFormDid, () => secrets);
    line.inbox = { link, pickup: new Pickup(link, this.handleOf(mediationId), { log: this.options.log }) };
    return line.inbox;
  }

  /** The receiver's pickup handle: a delivery's local work done in its turn, before the mediator is told of it, and its calls run off the turn. */
  private handleOf(mediationId: MediationId): Handle {
    const handle = this.receiver.pickupHandle(mediationId);
    const take = async (delivered: Delivered): Promise<Fate> => {
      if ("unreadable" in delivered) return handle(delivered);
      const received = await this.receiver.receive({ packed: delivered.packed, source: { kind: "pickup", mediationId, deliveryId: delivered.attachmentId }, parent: delivered.parent });
      this.detach(await this.decide(received));
      return received.outcome === "deferred" ? "skip" : "acked";
    };
    return Object.assign(take, { acknowledged: handle.acknowledged });
  }

  private async follow(received: Received): Promise<Inbound> {
    return (await this.decide(received))();
  }

  /**
   * A delivery's local work: what the vault owes recorded and, for a
   * live input, the private-address policy and then its automatic
   * effects decided under the lock, each intent committed with the
   * action the input minted for it. The policy goes first so that the
   * effects are fixed to the channel the input may still be answered
   * in: the address the policy replaces answers nothing after, and
   * the successor answers carrying the proof. What is returned makes
   * the calls, in that order, and tells the host.
   */
  private async decide(received: Received): Promise<Finish> {
    const inbound: Inbound = { received, after: null, reacted: null, address: null };
    if (received.outcome !== "received") return async () => this.tell(inbound);
    const { handlers, acknowledge, now, trace } = this.options;
    inbound.after = await this.step("what the vault owes", () => afterReceipt(this.runtime, this.keys, received.cid, { trace }));
    if (!received.live) return async () => this.tell(inbound);
    const live = new LiveInput(received.cid);
    const address = (this.options.privateAddresses ?? true) ? await this.step("the private address", () => decidePrivateAddress(this.runtime, this.keys, live, { now, trace })) : null;
    const effects = await this.step("the automatic effects", () => decideEffects(this.runtime, this.keys, live, { handlers, acknowledge, now, trace }));
    const dispatch = (action: LiveAction): Promise<Dispatched> => this.dispatcher.run(action);
    return async () => {
      if (address !== null) inbound.address = await this.step("the notification of the private address", () => callPrivateAddress(address, { dispatch, trace }));
      if (effects !== null) inbound.reacted = await this.step("the calls of the automatic effects", () => callEffects(effects, { dispatch, trace }));
      return this.tell(inbound);
    };
  }

  /** The calls of a pickup delivery, run off its turn after those of the delivery before; what they throw is logged, since nothing waits for them. */
  private detach(finish: Finish): void {
    this.calling = this.calling.then(finish).then(
      () => undefined,
      (err: unknown) => this.log(`the calls of a received message failed: ${messageOf(err)}`)
    );
  }

  private tell(inbound: Inbound): Inbound {
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
