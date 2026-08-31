/**
 * The agent over the v2 vault: every module of `src/v2` under one
 * running loop. The vault is the record and the fold its reading; the
 * agent is what moves — the mediation brought up and kept (`establish`,
 * `rotateStale`, `registerPending`), the mail picked up and answered
 * (`Pickup`, `Inbound`), the mail written and carried out (`Outbound`,
 * `Outbox`), the socket that makes delivery live, and the trace of all
 * of it. Everything the agent learns is an event in the log before
 * anyone is told: UIs mirror the vault; they are not the record.
 *
 * Moved from the v1 agent. What changed: the state the v1 agent carried
 * — records saved, caches loaded at start, DIDs re-derived by hand — is
 * the fold now, read fresh at every step; the seed stays outside
 * (`openVault` checked it, `Keys` holds it); and what each step means
 * lives in its own module, this class only running them in order. The
 * mediator, too, is an event: a fresh vault has none, `setMediator`
 * records the arrangement, and `start` brings it up or stops at
 * `unmediated`.
 */

import type { DIDDoc } from "@estoc/did-peer";
import type { EventStore } from "@estoc/event-store";
import {
  deleteContact,
  drafts,
  record,
  recordAll,
  type AttachCause,
  type ChannelKey,
  type Contact,
  type Delivery,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
  type VaultType,
} from "@estoc/vault/v2";
import { v7 as uuidv7 } from "uuid";

import { BASIC_MESSAGE } from "../protocol/basicmessage.js";
import type { DidcommApi } from "../protocol/didcomm.js";
import { RECIPIENT_UPDATE } from "../protocol/mediation.js";
import { resolveDid as defaultResolveDid } from "../protocol/resolver.js";
import { TRUST_PING } from "../protocol/spec.js";
import { outboundPair, resolvedOf } from "./channel.js";
import type { HandlerContext, ProtocolHandler, SendOptions } from "./handler.js";
import { basicmessageHandler } from "./handlers/basicmessage.js";
import { objectShareHandler } from "./handlers/object-share.js";
import { userProfileHandler } from "./handlers/user-profile.js";
import type { PeerVault } from "./identity.js";
import { Inbound } from "./inbound.js";
import { Keyring } from "./keyring.js";
import { MediatorLink, type Opened } from "./link.js";
import { establish, leave, register, registerPending, rotateStale, routedOf } from "./mediation.js";
import { invitationMessage, parseInvitation, type Invitation } from "./oob.js";
import { Outbound, Outbox, type Attempted } from "./outbound.js";
import { Pickup, type Fate } from "./pickup.js";
import {
  contactRecord,
  didPlaceholder,
  invitationRecord,
  messageRecord,
  nameOf,
  type ContactRecord,
  type InvitationRecord,
  type MessageRecord,
} from "./records.js";
import { AgentTrace, type TraceEvent, type TraceLevel, type TracePruneReport } from "./trace.js";

export type AgentStatus =
  | { state: "idle" }
  /** the log names no mediation: history reads, nothing moves until `setMediator` */
  | { state: "unmediated" }
  | { state: "connecting"; detail: string }
  | { state: "live" }
  | { state: "error"; detail: string };

export interface AgentEvents {
  onStatus(status: AgentStatus): void;
  /**
   * A message was recorded (sent or received), with the contact its
   * channel belongs to — null when the envelope was anonymous or the
   * channel is no contact's. What to show of it is the application's
   * projection of the fold.
   */
  onMessage(record: MessageRecord, contact: ContactRecord | null): void;
  /** a try at delivering a message of ours ended, and the fold says where it stands now */
  onDelivery(delivery: Delivery, record: MessageRecord): void;
  /** the agent created or renamed a contact; rotations and mints are the fold's to show */
  onContact(contact: ContactRecord): void;
  /** an invitation of ours was issued, revoked, or withdrawn */
  onInvitation(invitation: InvitationRecord): void;
  onLog(line: string): void;
}

export interface AgentOptions {
  /** the vault, opened: the seed was checked against the anchor there */
  vault: PeerVault;
  didcomm: DidcommApi;
  events?: Partial<AgentEvents>;
  /** DID resolution; defaults to the package's did:web + did:peer resolver */
  resolveDid?: (did: string) => Promise<DIDDoc | null>;
  /** transports, injectable for tests; default to the globals */
  fetch?: typeof fetch;
  WebSocket?: typeof WebSocket;
  /** the name announced over user-profile/1.0; defaults to the fold's `identity.label` */
  displayName?: () => string;
  /** how long to wait before reopening a closed socket */
  reconnectDelayMs?: number;
  /** how long one delivery or mediator round trip may take before it gives up (deliveries are retried later); default 15s */
  deliveryTimeoutMs?: number;
  /**
   * Application-protocol handlers, added to the built-in basicmessage/2.0,
   * user-profile/1.0 and object-share/1.0 ones; a handler naming a type a
   * built-in covers replaces the built-in for that type.
   */
  handlers?: ProtocolHandler[];
  /** a stranger's first message makes them a contact (default true); off, they stay unattributed */
  adoptStrangers?: boolean;
}

/** How often the trace is pruned while the agent runs; `start` prunes too. */
const TRACE_PRUNE_MS = 60 * 60 * 1000;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A document for a DID that does not resolve: enough to build a link whose requests then fail one by one. */
function unresolvable(did: string): DIDDoc {
  return { id: did, keyAgreement: [], authentication: [], verificationMethod: [], service: [] };
}

export class Agent {
  /** the vault as it was opened: the folder, the keys, the fold */
  readonly vault: PeerVault;
  private readonly didcomm: DidcommApi;
  private readonly events: Partial<AgentEvents>;
  private readonly resolveDid: (did: string) => Promise<DIDDoc | null>;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly wsImpl: typeof WebSocket | undefined;
  private readonly displayName: () => string;
  private readonly reconnectDelayMs: number;
  private readonly deliveryTimeoutMs: number | undefined;
  private readonly adoptStrangers: boolean | undefined;
  private readonly handlerList: ProtocolHandler[];
  private readonly handlerByType = new Map<string, ProtocolHandler>();
  /** the face the handlers see of this agent */
  private readonly ctx: HandlerContext;

  private ring: Keyring | null = null;
  private link: MediatorLink | null = null;
  private composer: Outbound | null = null;
  private outbox: Outbox | null = null;
  private pickup: Pickup | null = null;
  private inbound: Inbound | null = null;
  private trace: AgentTrace | null = null;
  private opening: Promise<AgentTrace> | null = null;
  private destroyed = false;
  /** a start that failed is tried again, later and later — this is the pending try */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startFailures = 0;
  /** the hourly trace prune, from the first start until destroy */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private _status: AgentStatus = { state: "idle" };
  /** per-key critical sections (see `locked`) */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** the lifecycle queue: starts and mediator moves run one at a time (see `start`, `setMediator`) */
  private lifecycle: Promise<void> = Promise.resolve();
  /** moved by every start, every mediator move and by destroy: an older continuation stops at its next checkpoint */
  private epoch = 0;
  /** introductions run one at a time, across every contact (see `introduced`) */
  private introducing: Promise<unknown> = Promise.resolve();
  /** what talks to the mediator over the standing link — outbox passes, invitation handouts and revocations, a move's leaving — one turn at a time, across every assembly (see `deliverTurn`) */
  private delivering: Promise<unknown> = Promise.resolve();
  /** inbound handling runs one opened envelope at a time, across every assembly, so two pickups cannot race the dedup (see `take`) */
  private receiving: Promise<unknown> = Promise.resolve();
  /** the mint lock, one chain for every composer this agent ever assembles (`OutboundOptions.choosing`) */
  private readonly choosing: { chain: Promise<unknown> } = { chain: Promise.resolve() };

  constructor(options: AgentOptions) {
    this.vault = options.vault;
    this.didcomm = options.didcomm;
    this.events = options.events ?? {};
    this.resolveDid = options.resolveDid ?? defaultResolveDid;
    this.fetchImpl = options.fetch;
    this.wsImpl = options.WebSocket;
    this.displayName = options.displayName ?? (() => this.fold.label() ?? "");
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs;
    this.adoptStrangers = options.adoptStrangers;
    this.handlerList = [basicmessageHandler, userProfileHandler, objectShareHandler, ...(options.handlers ?? [])];
    for (const handler of this.handlerList) {
      for (const type of handler.types) {
        this.handlerByType.set(type, handler);
      }
    }
    this.ctx = {
      fold: this.vault.fold,
      blobs: this.vault.vault.blobs,
      record: async <T extends VaultType>(draft: VaultDraft<T>): Promise<VaultEvent<T>> =>
        (await record(this.eventLog, this.fold, draft)) as VaultEvent<T>,
      send: (cid, type, body, sendOptions) => this.sendTo(cid, type, body, sendOptions),
      reply: (contact, type, body, sendOptions) => this.reply(contact, type, body, sendOptions),
      displayName: () => this.displayName(),
      log: (line) => this.log(line),
    };
  }

  private get fold(): VaultFold {
    return this.vault.fold;
  }

  private get eventLog(): EventStore {
    return this.vault.vault.events;
  }

  private get self(): string {
    return this.vault.vault.self;
  }

  /** The public DID correspondents write to; null until mediation completes. */
  get did(): string | null {
    return this.ring?.pub()?.identity.did ?? null;
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
    const trace = this.trace;
    if (trace !== null) {
      void trace.append("diag", "log", { text: line }).catch(() => undefined);
    }
  }

  // ---- the trace -------------------------------------------------------------

  /** The trace over the agent's local state, opened once at the level `options.json` names. */
  private traced(): Promise<AgentTrace> {
    this.opening ??= AgentTrace.open(this.vault.vault.local("agent")).then((trace) => (this.trace = trace));
    return this.opening;
  }

  /** Everything observed about one message record, across every stream (`AgentTrace.traceOf`). */
  async traceOf(mid: string): Promise<TraceEvent[]> {
    return (await this.traced()).traceOf(mid);
  }

  async traceLevel(): Promise<TraceLevel> {
    return (await this.traced()).level;
  }

  /** Keep at another level from now on and on every open after; what the new policy does not keep goes at once. */
  async setTraceLevel(level: TraceLevel): Promise<TracePruneReport[]> {
    return (await this.traced()).setLevel(level);
  }

  private async pruneTrace(): Promise<void> {
    try {
      await (await this.traced()).prune();
    } catch (err) {
      this.log(`trace prune failed: ${messageOf(err)}`);
    }
  }

  /** The hourly trace prune, from the first start (or mediator move) until destroy. */
  private keepPruning(): void {
    void this.pruneTrace();
    if (this.pruneTimer === null && !this.destroyed) {
      this.pruneTimer = setInterval(() => void this.pruneTrace(), TRACE_PRUNE_MS);
      (this.pruneTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  // ---- bringing it up --------------------------------------------------------

  /**
   * Bring the agent up: the ring derived from the log, the mediation
   * established (each step only when the fold lacks it), the invariants
   * a change of mediator leaves (`rotateStale`, `registerPending`), the
   * moved contacts pinged, the mediator's queue drained, the outbox
   * drained, live delivery opened. A vault whose device has no mediation
   * stops at `unmediated` — an identity is complete without one; it just
   * cannot be reached yet.
   *
   * A start that fails — offline, or the mediator away — reports `error`
   * and tries again by itself, at `reconnectDelayMs` doubling up to a
   * minute, until it comes up or the agent is destroyed: an app opened
   * with no network must not need reopening when the network returns.
   *
   * Starts are serialised on the lifecycle queue they share with
   * `setMediator`: a second start while one runs queues behind it, and
   * only the newest acts — the older one stops at its next checkpoint,
   * as a start does after `destroy` — so two starts cannot each
   * establish a mediation or leave a socket behind.
   */
  async start(): Promise<void> {
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.keepPruning();
    const epoch = ++this.epoch;
    const run = this.lifecycle.then(() => this.bringUp(epoch));
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  /** This start is not the one that counts any more: destroyed, or a newer start moved the epoch. */
  private halted(epoch: number): boolean {
    return this.destroyed || epoch !== this.epoch;
  }

  /**
   * The ring, brought up to the fold — one instance for the life of the
   * agent. A mint lands in the ring its composer holds; were a start to
   * build a fresh one, a key minted while it reloaded would sit in the
   * old ring only, and the assembly that follows could not open mail to
   * it. The (re)load rides the mint lock, so no mint lands between the
   * pass over the fold and its return.
   */
  private loadedRing(): Promise<Keyring> {
    const run = this.choosing.chain.then(async () => {
      const have = this.ring;
      if (have !== null) {
        await have.reload();
        return have;
      }
      const ring = await Keyring.load(this.vault);
      this.ring = ring;
      return ring;
    });
    this.choosing.chain = run.catch(() => undefined);
    return run;
  }

  private async bringUp(epoch: number): Promise<void> {
    if (this.halted(epoch)) {
      return;
    }
    try {
      this.setStatus({ state: "connecting", detail: "deriving keys" });
      const ring = await this.loadedRing();
      if (this.halted(epoch)) {
        return;
      }
      for (const skip of ring.skipped) {
        this.log(`leaving ${skip.key} out of the ring: it derives ${didPlaceholder(skip.derived)}, the log says ${didPlaceholder(skip.did)}`);
      }
      const mediation = ring.current();
      if (mediation === null) {
        this.setStatus({ state: "unmediated" });
        return;
      }

      this.setStatus({ state: "connecting", detail: "resolving mediator" });
      const mediatorDoc = await this.resolveDid(mediation.mediatorDid);
      if (mediatorDoc === null) {
        throw new Error("mediator DID does not resolve");
      }
      const trace = await this.traced();
      if (this.halted(epoch)) {
        return;
      }
      const link = this.assemble(trace, mediation.mediatorDid, mediatorDoc);

      this.setStatus({ state: "connecting", detail: "requesting mediation" });
      await establish(link, ring, this.vault);
      if (this.halted(epoch)) {
        return;
      }
      const rotated = await rotateStale(this.vault, ring);
      if (rotated.moved.length > 0) {
        this.log(`minted a fresh DID toward ${rotated.moved.length} contact(s); the old ones rode the old route`);
      }
      const pending = registerPending(this.fold, this.self);
      if (pending.length > 0) {
        this.log(`registering ${pending.length} DID(s) with the mediator`);
        await register(link, this.vault, pending);
      }
      if (this.halted(epoch)) {
        return;
      }
      if (rotated.moved.length > 0) {
        this.setStatus({ state: "connecting", detail: "telling contacts about the move" });
        await this.announceMove(rotated.moved);
      }

      if (this.halted(epoch)) {
        return;
      }
      this.setStatus({ state: "connecting", detail: "picking up queued mail" });
      await (this.pickup as Pickup).drain();
      if (this.halted(epoch)) {
        return;
      }
      if ((this.outbox as Outbox).waiting().length > 0) {
        this.setStatus({ state: "connecting", detail: "sending queued mail" });
        await this.drained();
      }

      if (this.halted(epoch)) {
        return;
      }
      this.setStatus({ state: "connecting", detail: "opening live delivery" });
      this.startFailures = 0;
      this.openSocket(link);
    } catch (err) {
      if (this.halted(epoch)) {
        return;
      }
      this.setStatus({ state: "error", detail: messageOf(err) });
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

  /** The modules over one link, rebuilt at every start: the fold under them is the same. */
  private assemble(trace: AgentTrace, mediatorDid: string, mediatorDoc: DIDDoc): MediatorLink {
    // a start over a standing assembly closes its socket first: one socket at a time
    this.link?.closeSocket();
    const ring = this.ring as Keyring;
    const link = this.newLink(trace, ring, mediatorDid, mediatorDoc);
    this.link = link;
    const composer = new Outbound(this.vault, ring, link, {
      didcomm: this.didcomm,
      resolveDid: this.resolveDid,
      choosing: this.choosing,
      log: (line) => this.log(line),
      ...(this.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: this.deliveryTimeoutMs }),
    });
    this.composer = composer;
    this.outbox = new Outbox(this.vault, link, composer, { log: (line) => this.log(line) });
    // the inbound policy holds no link and survives restarts: its dedup of
    // wire ids keeps counting across assemblies; the ring it asks is the
    // current one, read late
    this.inbound ??= new Inbound(this.vault, this.ctx, {
      resolveDid: this.resolveDid,
      keyOfDid: (did) => this.ring?.keyOfDid(did) ?? null,
      handlers: this.handlerList,
      ...(this.adoptStrangers === undefined ? {} : { adoptStrangers: this.adoptStrangers }),
    });
    this.pickup = new Pickup(link, (opened) => this.take(opened), {
      onLive: () => {
        if (this.destroyed || this.link !== link) {
          return;
        }
        this.setStatus({ state: "live" });
        this.log("live delivery is on");
      },
      log: (line) => this.log(line),
    });
    return link;
  }

  private newLink(trace: AgentTrace, ring: Keyring, mediatorDid: string, mediatorDoc: DIDDoc): MediatorLink {
    return new MediatorLink({
      didcomm: this.didcomm,
      resolveDid: this.resolveDid,
      trace,
      secrets: () => ring.secrets(),
      me: () => {
        const me = ring.me;
        if (me === null) {
          throw new Error("no mediation yet");
        }
        return me.identity;
      },
      mediatorDid,
      mediatorDoc,
      log: (line) => this.log(line),
      ...(this.deliveryTimeoutMs === undefined ? {} : { timeoutMs: this.deliveryTimeoutMs }),
      ...(this.fetchImpl === undefined ? {} : { fetch: this.fetchImpl }),
      ...(this.wsImpl === undefined ? {} : { WebSocket: this.wsImpl }),
    });
  }

  /**
   * One opened envelope from the pickup: in turn with every other —
   * across assemblies, so an old socket's frame still in flight and a
   * fresh pickup's fetch cannot race the dedup — through the inbound
   * policy, the open noted with its record, the application told.
   */
  private take(opened: Opened): Promise<Fate> {
    const run = this.receiving.then(async (): Promise<Fate> => {
      const handled = await (this.inbound as Inbound).handle(opened);
      if (handled.outcome === "recorded") {
        await (this.link as MediatorLink).noteOpen(opened, handled.record.mid);
        this.events.onMessage?.(handled.record, handled.contact);
      }
      return "acked";
    });
    this.receiving = run.catch(() => undefined);
    return run;
  }

  private openSocket(link: MediatorLink): void {
    if (this.destroyed || this.link !== link) {
      return;
    }
    const pickup = this.pickup as Pickup;
    link.openSocket(
      (opened) => pickup.onFrame(opened),
      () => {
        if (this.destroyed || this.link !== link) {
          return;
        }
        this.setStatus({ state: "connecting", detail: "socket closed; reconnecting" });
        setTimeout(() => {
          if (!this.destroyed && this.link === link) {
            void this.reconnect(link);
          }
        }, this.reconnectDelayMs);
      }
    );
  }

  /**
   * Live delivery only pushes what arrives while the socket is up; mail
   * queued during an outage waits for a pickup. So a reconnect drains
   * first — the mediator's queue for us, then our outbox, since a socket
   * coming back is the sign the network did — then reopens the socket.
   */
  private async reconnect(link: MediatorLink): Promise<void> {
    if (this.destroyed || this.link !== link) {
      return;
    }
    try {
      await (this.pickup as Pickup).drain();
      await this.drained();
    } catch (err) {
      this.log(`pickup on reconnect failed: ${messageOf(err)}`);
    }
    if (!this.destroyed && this.link === link) {
      this.openSocket(link);
    }
  }

  /**
   * After a move: a trust-ping (no response asked) to every moved contact
   * we have introduced ourselves to, from the new key, `from_prior`
   * riding along — so they learn the new address now rather than at our
   * next message. Best effort per contact; the next message carries it anyway.
   */
  private async announceMove(moved: string[]): Promise<void> {
    for (const cid of moved) {
      const contact = this.fold.contact(cid);
      if (contact === null || contact.profileSharedAt === null) {
        continue;
      }
      const known = contactRecord(contact);
      try {
        const sent = await this.reply(known, TRUST_PING, { response_requested: false });
        if (this.fold.delivery(sent.mid)?.status === "sent") {
          this.log(`told ${known.name} about our new DID`);
        } else {
          this.log(`could not tell ${known.name} about our new DID yet; the outbox will`);
        }
      } catch (err) {
        this.log(`could not tell ${known.name} about our new DID (${messageOf(err)}); the next message will`);
      }
    }
  }

  // ---- moving mediator -------------------------------------------------------

  /**
   * Name the mediator, then bring the loop up: mediate, mint the public
   * DID, go live. The mediator is chosen after the identity exists, not
   * with it — and may be changed later, which leaves the old mediation
   * (`leave`: the public DID and open invitations retired, the old
   * mediator asked to drop what it knew), records the new arrangement,
   * and mints what the new one calls for (`rotateStale` re-keys every
   * contact).
   *
   * The move rides the lifecycle queue. The epoch moves now, so a start
   * midway stops at its next checkpoint — before the leaving begins, and
   * with everything it registered still on the fold for the drop list —
   * and the transition takes the next turn. The leaving itself is a
   * turn on the delivery queue: an add still in flight toward the old
   * mediator — a stalled pass registering its key, an invitation being
   * handed out — lands and is recorded before the drop list is read,
   * and no pass runs mid-leave. Once its turn comes, the two
   * records (the retirement, the new arrangement) land whatever else was
   * asked meanwhile: a stop between them is the crash the next start
   * heals. Only the closing bring-up yields to a newer call, which does
   * its own.
   */
  async setMediator(mediatorDid: string): Promise<void> {
    if (this.ring === null) {
      await this.loadedRing();
    }
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.keepPruning();
    const epoch = ++this.epoch;
    const run = this.lifecycle.then(() => this.moveMediator(epoch, mediatorDid));
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async moveMediator(epoch: number, mediatorDid: string): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const ring = this.ring as Keyring;
    const mediation = ring.current();
    if (mediation !== null) {
      if (mediation.mediatorDid === mediatorDid) {
        throw new Error("already reached via that mediator");
      }
      await this.deliverTurn(() => this.leaveMediator(ring, mediation.mediatorDid));
    }
    await ring.createMediation(mediatorDid);
    await this.bringUp(epoch);
  }

  /**
   * Leaving the old mediator: the socket goes, `leave` retires the
   * public DID and the open invitations (their routes lead to a mediator
   * that is no longer ours) and asks it — best effort — to drop every
   * DID it was told of, so mail to a stale DID fails at the sender
   * rather than queueing where nobody will look.
   */
  private async leaveMediator(ring: Keyring, oldMediatorDid: string): Promise<void> {
    this.link?.closeSocket();
    this.setStatus({ state: "connecting", detail: "leaving the old mediator" });
    const open = this.fold.invitations().filter((invitation) => invitation.open);
    let link = this.link;
    if (link === null || link.mediatorDid !== oldMediatorDid) {
      const doc = await this.resolveDid(oldMediatorDid);
      link = this.newLink(await this.traced(), ring, oldMediatorDid, doc ?? unresolvable(oldMediatorDid));
    }
    const left = await leave(link, this.vault);
    if (left !== null) {
      if (left.failed !== null) {
        this.log(`could not tell the old mediator we are leaving: ${left.failed}`);
      } else if (left.dropped.length > 0) {
        this.log(`asked the old mediator to drop ${left.dropped.length} DID(s) of ours`);
      }
    }
    if (open.length > 0) {
      this.log(`withdrew ${open.length} open invitation link(s); they led to the old mediator`);
      for (const invitation of open) {
        this.events.onInvitation?.(this.invitationOf(invitation.key));
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.epoch += 1;
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.link?.closeSocket();
  }

  // ---- sending ---------------------------------------------------------------

  /**
   * Send a message of any application protocol to the contact who wears
   * `did`; a stranger's DID becomes a contact first. Resolves to the
   * record once its first delivery has been tried — whether that try
   * succeeded is a delivery event (`onDelivery`), not an error here:
   * what could not go now waits in the outbox. Throws only when nothing
   * can be composed at all (no mediation granted). The first message to
   * anyone is preceded by an introduction — every handler that has one
   * to make (user-profile announces our name and asks for theirs) makes
   * it, once per contact.
   */
  async send(did: string, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord> {
    this.composerOf();
    const cid = await this.ensureContact(did);
    return this.sendTo(cid, type, body, options);
  }

  /** Send a basicmessage/2.0; resolves to the record. */
  sendBasicMessage(did: string, text: string): Promise<MessageRecord> {
    return this.send(did, BASIC_MESSAGE, { content: text });
  }

  /** `send` by contact — what `HandlerContext.send` is. */
  private async sendTo(cid: string, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord> {
    await this.introduced(cid);
    return this.reply(this.contactRecordOf(cid), type, body, options);
  }

  /**
   * Compose, record and deliver one message to a contact — no
   * introduction: the handlers' own traffic, and every send once the
   * introduction is made. The record is an event before the wire is
   * tried; whatever was waiting for the same contact goes first, in order.
   */
  private async reply(contact: ContactRecord, type: string, body: Record<string, unknown>, options?: SendOptions): Promise<MessageRecord> {
    const composer = this.composerOf();
    const composed = await composer.compose(contact.cid, type, body, options);
    const found = await composer.record(composed);
    this.events.onMessage?.(found, this.contactRecordOf(contact.cid));
    await this.drained({ cid: this.contactRecordOf(contact.cid).cid });
    return found;
  }

  /**
   * Every handler's introduction, once per contact — `profile.shared` on
   * the fold is the once. One introduction at a time, across every
   * contact and not per contact: the representative a lock could key on
   * can change under a merge while an introduction is in flight, and a
   * lock keyed on it would split one contact across two locks and
   * introduce twice (the same reasoning as `Outbound`'s mint lock).
   * Introductions happen once per relationship, so the queue stays
   * short; a later caller finds `profile.shared` on the fold and does
   * nothing.
   */
  private introduced(cid: string): Promise<void> {
    if (this.contactRecordOf(cid).profileSharedAt !== null) {
      return Promise.resolve();
    }
    const run = this.introducing.then(async () => {
      const current = this.contactRecordOf(cid);
      if (current.profileSharedAt !== null) {
        return;
      }
      for (const handler of new Set(this.handlerByType.values())) {
        if (handler.introduce !== undefined) {
          await handler.introduce(current, this.ctx);
        }
      }
    });
    this.introducing = run.catch(() => undefined);
    return run;
  }

  /** Try again to deliver one message of ours, held or failed — by hand, so a held one is tried too. */
  async retry(mid: string): Promise<Attempted> {
    return this.deliverTurn(async () => {
      const outbox = this.outbox;
      if (outbox === null) {
        throw new Error("no mediation granted yet: nothing to write from");
      }
      const event = await outbox.retry(mid);
      await this.told([event]);
      return event;
    });
  }

  /** Try everything waiting in the outbox now — a browser's `online` event. Held stays held. */
  async flush(): Promise<Attempted[]> {
    return this.deliverTurn(async () => {
      const outbox = this.outbox;
      if (outbox === null) {
        return [];
      }
      const tried = await outbox.flush();
      await this.told(tried);
      return tried;
    });
  }

  /** One outbox pass, and the application told of every try it made. */
  private drained(only: { cid?: string; mid?: string } = {}): Promise<Attempted[]> {
    return this.deliverTurn(async () => {
      const outbox = this.outbox;
      if (outbox === null) {
        return [];
      }
      const tried = await outbox.drain(only);
      await this.told(tried);
      return tried;
    });
  }

  /**
   * One delivery pass at a time, across every assembly: a restart swaps
   * the Outbox, and a fresh one must not run a pass beside one still in
   * flight on the old — two passes over one fold would each see the same
   * message unsent and send it twice. The outbox is read once the turn
   * comes, so a pass queued across a restart runs on the current one.
   * What registers with the mediator rides the same queue — a pass's
   * add, an invitation's — so a mediator move takes a turn to know
   * every add has landed before it reads the drop list (`setMediator`).
   */
  private deliverTurn<T>(step: () => Promise<T>): Promise<T> {
    const run = this.delivering.then(step);
    this.delivering = run.catch(() => undefined);
    return run;
  }

  private async told(tried: Attempted[]): Promise<void> {
    for (const event of tried) {
      const delivery = this.fold.delivery(event.data.mid);
      const found = await messageRecord(this.fold, this.vault.vault.blobs, event.data.mid);
      if (delivery !== null && found !== null) {
        this.events.onDelivery?.(delivery, found);
      }
    }
  }

  private composerOf(): Outbound {
    if (this.composer === null) {
      throw new Error("no mediation granted yet: nothing to write from");
    }
    return this.composer;
  }

  // ---- contacts --------------------------------------------------------------

  /**
   * Name a contact. A DID that already belongs to one renames it rather
   * than duplicating; a new DID is resolved and gets a record of its own
   * — created, their document read onto the channel, attached by hand.
   */
  async addContact(did: string, name: string): Promise<ContactRecord> {
    const cid = await this.locked(`contact ${did}`, async () => {
      const have = this.contactByDid(did);
      if (have === null) {
        return this.adopt(did, name, "manual", null);
      }
      await record(this.eventLog, this.fold, drafts.contactPetname({ cid: have.cid, name }));
      const renamed = this.contactRecordOf(have.cid);
      this.events.onContact?.(renamed);
      return have.cid;
    });
    return this.contactRecordOf(cid);
  }

  /**
   * Accept someone's invitation — a URL, its `_oob` parameter, or the
   * plaintext — under a petname: they become a contact by the DID the
   * invitation names, attached `accepted` with its id (our first
   * messages name it as `pthid`), and we introduce ourselves at once
   * when mediation is up — or the first message will. Our own
   * invitations, and a mediator's, are refused.
   */
  async acceptInvitation(input: string | Invitation, name: string): Promise<ContactRecord> {
    const invitation = typeof input === "string" ? parseInvitation(input) : input;
    if (invitation.body.goal_code === "request-mediate") {
      throw new Error("that is a mediator's invitation, not a person's");
    }
    if (this.fold.myKeys().some((key) => key.minted?.did === invitation.from)) {
      throw new Error("that is an invitation of your own");
    }
    const cid = await this.locked(`contact ${invitation.from}`, async () => {
      const have = this.contactByDid(invitation.from);
      if (have === null) {
        return this.adopt(invitation.from, name, "accepted", invitation.id);
      }
      const batch: VaultDraft[] = [drafts.contactPetname({ cid: have.cid, name })];
      if (!have.attached.some((attach) => attach.because === "accepted")) {
        const pair = await this.pairWearing(have, invitation.from);
        batch.push(drafts.contactAttached({ ...pair, cid: have.cid, because: "accepted", oobId: invitation.id }));
      }
      await recordAll(this.eventLog, this.fold, batch);
      this.events.onContact?.(this.contactRecordOf(have.cid));
      return have.cid;
    });
    if (this.ring?.pub() !== null && this.ring !== null && this.contactRecordOf(cid).profileSharedAt === null) {
      try {
        await this.introduced(cid);
      } catch (err) {
        this.log(`could not answer the invitation yet (${messageOf(err)}); the first message will`);
      }
    }
    return this.contactRecordOf(cid);
  }

  /**
   * Forget a contact (§9): the mediator is asked to stop accepting mail
   * for the DIDs we minted toward them (best effort — the keys stay
   * burned either way), then the tombstones, the erases, the
   * retirements, the collection (`deleteContact`).
   */
  async removeContact(cid: string): Promise<void> {
    const contact = this.fold.contact(cid);
    if (contact === null) {
      return;
    }
    const dids: string[] = [];
    for (const use of contact.keys) {
      const key = this.fold.myKey(use.key);
      if (key !== null && key.minted !== null && key.registered.includes(this.self)) {
        dids.push(key.minted.did);
      }
    }
    if (dids.length > 0 && this.link !== null) {
      try {
        await this.link.roundTrip(RECIPIENT_UPDATE, { updates: dids.map((did) => ({ recipient_did: did, action: "remove" })) });
      } catch (err) {
        this.log(`could not unregister our DIDs toward ${nameOf(contact)}: ${messageOf(err)}`);
      }
    }
    await deleteContact(this.vault.vault, this.fold, contact.cid);
  }

  /** The contact who wears `did`, made if missing (resolved, created, attached by hand). */
  private ensureContact(did: string): Promise<string> {
    return this.locked(`contact ${did}`, async () => {
      const have = this.contactByDid(did);
      return have !== null ? have.cid : this.adopt(did, null, "manual", null);
    });
  }

  /** A contact for a DID: created (petnamed when named), their document read onto the channel, attached — one write. */
  private async adopt(did: string, name: string | null, because: AttachCause, oobId: string | null): Promise<string> {
    const doc = await this.resolveDid(did);
    if (doc === null) {
      throw new Error(`${didPlaceholder(did)} does not resolve`);
    }
    const { pair } = outboundPair(null, doc);
    const cid = uuidv7();
    const batch: VaultDraft[] = [drafts.contactCreated({ cid })];
    if (name !== null) {
      batch.push(drafts.contactPetname({ cid, name }));
    }
    batch.push(drafts.peerResolved(resolvedOf(pair, did, doc)));
    batch.push(drafts.contactAttached({ ...pair, cid, because, ...(oobId === null ? {} : { oobId }) }));
    await recordAll(this.eventLog, this.fold, batch);
    this.events.onContact?.(this.contactRecordOf(cid));
    return cid;
  }

  private contactByDid(did: string): Contact | null {
    return this.fold.contacts().find((contact) => contact.theirDids.some((entry) => entry.did === did)) ?? null;
  }

  /**
   * The channel a DID of a contact's is on: the one it was resolved on,
   * else one its identity graph names — the fold has both, so accepting
   * an invitation for a known contact asks no resolver. A DID on none of
   * their channels is resolved afresh, and a resolution that fails then
   * is an error, not a silent shrug.
   */
  private async pairWearing(contact: Contact, did: string): Promise<ChannelKey> {
    for (const pair of contact.channels) {
      if (this.fold.channel(pair)?.resolved.some((entry) => entry.did === did) ?? false) {
        return pair;
      }
    }
    for (const pair of contact.channels) {
      if (this.fold.channel(pair)?.dids.includes(did) ?? false) {
        return pair;
      }
    }
    const doc = await this.resolveDid(did);
    if (doc === null) {
      throw new Error(`${didPlaceholder(did)} does not resolve`);
    }
    return outboundPair(null, doc).pair;
  }

  private contactRecordOf(cid: string): ContactRecord {
    const contact = this.fold.contact(cid);
    if (contact === null) {
      throw new Error(`no contact ${cid}`);
    }
    return contactRecord(contact);
  }

  // ---- invitations -----------------------------------------------------------

  /**
   * Issue a single-use invitation: a DID minted for whoever answers
   * first, published as `oob`, registered with the mediator so their
   * answer has somewhere to land. A registration that fails throws — the
   * URL is not usable yet — but the invitation is on record, and the
   * next start registers it (`registerPending`); with no link up at
   * all, nothing is minted. `goal` is what the
   * invitation says it is for, in words for the person opening it.
   * The handout is a turn on the delivery queue: a mediator move waits
   * for it and retires and drops the invitation with the rest, rather
   * than racing its registration.
   */
  async createInvitation(goal?: string): Promise<InvitationRecord> {
    return this.deliverTurn(async () => {
      const ring = this.ring;
      const routed = ring === null ? null : routedOf(ring.current());
      if (ring === null || routed === null) {
        throw new Error("no mediation granted yet: nothing to hand out");
      }
      const link = this.link;
      if (link === null) {
        throw new Error("the mediator is not reachable yet: an invitation issued now would go unregistered");
      }
      const minted = await ring.mintInvitation(routed, uuidv7(), goal ?? `Write to ${this.displayName()}`);
      await register(link, this.vault, [minted.key]);
      this.log("issued an invitation; the first to write to it takes it");
      const issued = this.invitationOf(minted.key);
      this.events.onInvitation?.(issued);
      return issued;
    });
  }

  /**
   * Withdraw an open invitation: the mediator is asked to stop accepting
   * mail for its DID (best effort), and the key is retired. A taken
   * invitation is not revoked — its key is ours toward someone now;
   * forget the contact instead.
   */
  async revokeInvitation(id: string): Promise<void> {
    return this.deliverTurn(async () => {
      const found = this.invitations().find((invitation) => invitation.id === id);
      if (found === undefined) {
        return;
      }
      if (!found.open) {
        throw new Error("that invitation was taken; its DID belongs to a contact now");
      }
      if (found.registered && found.did !== null && this.link !== null) {
        try {
          await this.link.roundTrip(RECIPIENT_UPDATE, { updates: [{ recipient_did: found.did, action: "remove" }] });
        } catch (err) {
          this.log(`could not unregister an invitation's DID: ${messageOf(err)}`);
        }
      }
      await record(this.eventLog, this.fold, drafts.didRetired({ key: found.key, because: "revoked" }));
      this.events.onInvitation?.(this.invitationOf(found.key));
      this.log("revoked an invitation");
    });
  }

  /** The invitations this vault has issued, open and taken, oldest first. */
  invitations(): InvitationRecord[] {
    return this.fold.invitations().map((invitation) => invitationRecord(this.fold, invitation));
  }

  /** The message an invitation of ours stands for — what `invitationUrl` encodes. */
  invitationMessage(record: InvitationRecord): Invitation {
    return invitationMessage(record);
  }

  private invitationOf(key: string): InvitationRecord {
    const found = this.fold.invitations().find((invitation) => invitation.key === key);
    if (found === undefined) {
      throw new Error(`no invitation on ${key}`);
    }
    return invitationRecord(this.fold, found);
  }

  // ---- inside ----------------------------------------------------------------

  /**
   * Run `step` after every earlier step under the same key has finished:
   * how two calls that would each create the same contact or introduce
   * us twice are made to take turns instead.
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
}
