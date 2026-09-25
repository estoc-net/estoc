/**
 * Every delivery this runtime is handed — an attachment the mediator
 * delivered, or an envelope posted straight to it — goes through one
 * gate before anything reaches the vault. The recipients it names
 * decide first: a delivery this vault may never open is terminal, one
 * waiting on something recoverable of this runtime's is held. It is
 * then opened with the one key it may be opened with, its sender read
 * from what the vault holds and nothing else, and what the envelope
 * proves checked; what passes goes to the receipt, which records it as
 * one observation, told here by its event, or says what of this
 * runtime's it still waits for. A terminal delivery is acknowledged to
 * the mediator and leaves nothing in the vault, only a bounded
 * diagnostic here and in the trace: what it lacked, without a claimed
 * sender presented as anyone, and without a cause asserted.
 *
 * A runtime receives through one receiver at a time, so that every way
 * a delivery arrives — a pickup's drain, the socket, a direct post, a
 * retry after a local change — shares what is kept of it. That is in
 * memory only: why it waits, its bytes while they fit, and how it ended
 * until the mediator is told. A delivery that ended is not opened again
 * when it comes again, only told again, so that a lost acknowledgement
 * costs no second opening; a direct post, which no one acknowledges, is
 * remembered until newer ones push it out. A delivery that waits is not
 * opened again when it is redelivered: only a change of what it waits
 * for retries it, from the bytes held or at the next redelivery, and
 * one retried off a pickup's turn is acknowledged through `acknowledge`
 * once it is received or found terminal. A delivery waits only for
 * something the fold can show; where the vault cannot be read or the
 * receipt throws, nothing is kept of the delivery — a wait it had is
 * let go with its bytes — and it comes again from where it came, into
 * the gate afresh. What is kept is bounded: past as many waiting
 * deliveries as are allowed, a delivery that would wait is likewise
 * left where it came from, since the mediator's copy is the only copy
 * and nothing addressed here may be dropped for want of room. Nothing
 * here waits for the network or for evidence about a peer: a sender
 * the vault cannot authenticate now is refused now.
 */

import type { Secret } from "@estoc/did-peer";
import { canonicalize, parseStrict, type VaultRuntime } from "@estoc/event-store";
import { rawCidOfBytes, scanVault, type Did, type DidId, type DidUrl, type EventReference, type Keys, type KeyName, type MediationId, type VaultFold } from "@estoc/vault";

import { secretsResolverFor, unpack, type DidcommApi, type IMessage, type UnpackMetadata } from "../protocol/didcomm.js";
import { envelopeHeader } from "../protocol/envelope.js";
import { ReceiverClosed, ReceiverInUse } from "../errors.js";
import { pinnedResolver } from "../evidence.js";
import type { Keyring } from "../keyring.js";
import type { Delivered, Fate, Handle } from "../pickup.js";
import { serially } from "../procedure.js";
import { sameDid } from "../same-did.js";
import { note, type AgentTrace, type TraceData } from "../trace.js";
import { classifyRecipients, sealingOf, senderEvidence, senderProof, type AuthenticatedSender } from "./gate.js";

/** Where a delivery came from: an attachment of a pickup delivery, by the arrangement and attachment ID, or a post straight to this runtime. */
export type Source = { kind: "pickup"; mediationId: MediationId; deliveryId: string } | { kind: "direct" };

export interface Delivery {
  packed: string;
  source: Source;
  /** the trace entry the delivery arrived inside */
  parent?: number;
}

export interface Authenticated {
  delivery: Delivery;
  plaintext: IMessage;
  metadata: UnpackMetadata;
  /** the key of this vault it was opened with */
  recipient: { didId: DidId; did: Did; kid: DidUrl; localKeyName: KeyName };
  /** null for an anonymous envelope */
  sender: AuthenticatedSender | null;
  /** the rotation proof as it came off the wire, for the vault to judge once the message is recorded */
  fromPrior: string | null;
}

/**
 * What a waiting delivery waits for of this runtime's, as the fold says
 * it: the delivery is retried when this says something else than it
 * did when the delivery was held, and not for any other change.
 */
export type Watch = (fold: VaultFold) => string;

/**
 * What the receipt made of an authenticated delivery: recorded as the
 * observation named, which ends it; terminal; or deferred for
 * something of this runtime's that the fold can show is not ready,
 * with a watch over it. `first` says the vault held no observation of
 * the same input when this one was recorded. A receipt that cannot
 * record for another reason throws instead, and the delivery is not
 * kept.
 */
export type ReceiptOutcome = { outcome: "received"; cid: EventReference<"message.in">; first: boolean } | { outcome: "terminal"; reason: string } | { outcome: "deferred"; reason: string; watch: Watch };

export type Receipt = (authenticated: Authenticated) => Promise<ReceiptOutcome>;

/**
 * What became of a delivery. `key` is what it is kept under; null only
 * for a direct post that is not strict JSON. `live` is true of one call
 * alone for any input: the one that recorded the first observation the
 * vault holds of it. An input the vault already held, delivered again
 * under any delivery and to any receiver, is observed again and is not
 * live, and neither is a delivery only told how it ended before.
 */
export type Received =
  | { outcome: "received"; key: string; cid: EventReference<"message.in">; live: boolean }
  | { outcome: "terminal"; key: string | null; reason: string }
  | { outcome: "deferred"; key: string; reason: string };

export interface WaitingDelivery {
  key: string;
  source: Source;
  reason: string;
  /** whether its bytes are held, so a retry needs no redelivery */
  held: boolean;
}

export interface Discarded {
  source: Source;
  reason: string;
}

/** What `admit` is asked about, once a delivery is authenticated and before it is recorded. */
export interface Ingress {
  source: Source;
  recipient: Did;
  /** null for an anonymous envelope */
  sender: Did | null;
  bytes: number;
}

export interface ReceiverOptions {
  didcomm: DidcommApi;
  receipt: Receipt;
  /** acknowledges a pickup delivery retried off a pickup's turn */
  acknowledge?: (source: Extract<Source, { kind: "pickup" }>) => Promise<void>;
  /** the host's abuse and resource limits: the reason a delivery is refused, or null to admit it */
  admit?: (ingress: Ingress) => string | null;
  /** the most deliveries kept waiting at once; past it, one that would wait is left where it came from */
  maxWaiting?: number;
  /** the most envelope bytes held for retries, all deliveries together */
  maxHeldBytes?: number;
  trace?: AgentTrace;
  log?: (line: string) => void;
}

export const MAX_WAITING = 1024;

export const MAX_HELD_BYTES = 16 * 1024 * 1024;

/** The longest a reason kept or traced runs to: a reason names at most a few long-form DIDs, but what an envelope names is the envelope's to make long. */
export const REASON_KEPT = 4096;

/** How many ended deliveries are remembered at once; past it the oldest is forgotten, and comes again as a new delivery. */
export const ENDED_KEPT = 1024;

/** How many discarded deliveries are kept for display; past it the oldest is forgotten. */
export const DISCARDED_KEPT = 256;

interface Wait {
  source: Source;
  reason: string;
  watch: Watch;
  /** what the watch said over the fold the delivery was held on */
  seen: string;
  /** what it waits for changed while no bytes were held: the next redelivery is opened */
  retry: boolean;
}

interface HeldDelivery {
  delivery: Delivery;
  bytes: number;
}

type Ended = Exclude<Received, { outcome: "deferred" }>;

const utf8 = new TextEncoder();

const receivers = new WeakMap<VaultRuntime, Receiver>();

export class Receiver {
  private readonly log: (line: string) => void;
  private readonly maxWaiting: number;
  private readonly maxHeldBytes: number;
  private readonly waits = new Map<string, Wait>();
  private readonly held = new Map<string, HeldDelivery>();
  private heldBytes = 0;
  private readonly ended = new Map<string, Ended>();
  private readonly discardedRing: Discarded[] = [];
  /** counts the local changes told of, so that an attempt knows whether one came while it read the vault */
  private changes = 0;
  private closed = false;

  /** Throws `ReceiverInUse` while another receiver of `runtime` is open. */
  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly ring: Keyring,
    private readonly options: ReceiverOptions
  ) {
    if (receivers.has(runtime)) throw new ReceiverInUse();
    receivers.set(runtime, this);
    this.log = options.log ?? (() => undefined);
    this.maxWaiting = options.maxWaiting ?? MAX_WAITING;
    this.maxHeldBytes = options.maxHeldBytes ?? MAX_HELD_BYTES;
  }

  /** One delivery through the gate, in turn with every other step for the same delivery. */
  async receive(delivery: Delivery): Promise<Received> {
    this.refuseClosed();
    const key = deliveryKey(delivery);
    if (key === null) {
      const reason = "the envelope is not strict JSON";
      await this.discard(delivery, reason);
      return { outcome: "terminal", key, reason };
    }
    return this.inTurn(key, () => this.enter(key, delivery));
  }

  /**
   * The pickup handle for one arrangement: a delivery received or
   * terminal is taken, a held one left queued. Told which attachments
   * the mediator was told of, it forgets how they ended.
   */
  pickupHandle(mediationId: MediationId): Handle {
    const take = async (delivered: Delivered): Promise<Fate> => {
      const source: Source = { kind: "pickup", mediationId, deliveryId: delivered.attachmentId };
      if (!("unreadable" in delivered)) {
        const received = await this.receive({ packed: delivered.packed, source, parent: delivered.parent });
        return received.outcome === "deferred" ? "skip" : "acked";
      }
      this.refuseClosed();
      const key = pickupKey(mediationId, delivered.attachmentId);
      await this.inTurn(key, () => {
        this.refuseClosed();
        return this.finish(key, { packed: "", source, parent: delivered.parent }, `the attachment does not read: ${delivered.unreadable}`);
      });
      return "acked";
    };
    const acknowledged = (attachmentIds: readonly string[]): void => {
      for (const attachmentId of attachmentIds) this.ended.delete(pickupKey(mediationId, attachmentId));
    };
    return Object.assign(take, { acknowledged });
  }

  /**
   * Something of this runtime's changed: every waiting delivery whose
   * watch now says something else is retried from its bytes, or opened
   * at its next redelivery when they are not held. When the vault
   * cannot be read to compare, nothing can be told of any wait, and
   * every waiting delivery is let go to come again from where it came.
   */
  async localStateChanged(): Promise<Received[]> {
    this.changes += 1;
    const waiting = [...this.waits];
    if (waiting.length === 0) return [];
    const fold = await this.foldOrNull();
    const results: Received[] = [];
    for (const [key, wait] of waiting) {
      if (this.closed) break;
      if (fold !== null && wait.watch(fold) === wait.seen) continue;
      const received = await this.inTurn(key, () => {
        if (this.waits.get(key) !== wait) return Promise.resolve(null);
        return fold === null ? this.leave(key, wait, "the vault is not read to tell what changed") : this.retry(key, wait);
      });
      if (received !== null) results.push(received);
    }
    return results;
  }

  waiting(): WaitingDelivery[] {
    return [...this.waits].map(([key, wait]) => ({ key, source: wait.source, reason: wait.reason, held: this.held.has(key) }));
  }

  /** The deliveries found terminal, oldest first, as many as are kept. */
  discarded(): Discarded[] {
    return [...this.discardedRing];
  }

  /**
   * No delivery is handed to the receipt after this. One not yet handed
   * to the receipt — waiting its turn, or with its vault read or its
   * opening still under way, however that then ends — is refused with
   * `ReceiverClosed` and stays wherever it came from. One whose receipt
   * was already called ends as the receipt says, since the receipt may
   * have recorded it. Everything kept is let go; the runtime may then
   * have another receiver.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waits.clear();
    this.held.clear();
    this.heldBytes = 0;
    this.ended.clear();
    receivers.delete(this.runtime);
  }

  private refuseClosed(): void {
    if (this.closed) throw new ReceiverClosed();
  }

  /** Steps for one delivery run one at a time under its runtime, so that a receiver closed while finishing one still goes before the next receiver's. */
  private inTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
    return serially(this.runtime, key, work);
  }

  private async foldOrNull(): Promise<VaultFold | null> {
    try {
      return await scanVault(this.runtime.vault, this.keys);
    } catch {
      return null;
    }
  }

  private enter(key: string, delivery: Delivery): Promise<Received> {
    this.refuseClosed();
    const ended = this.ended.get(key);
    if (ended !== undefined) return Promise.resolve(ended.outcome === "received" ? { ...ended, live: false } : ended);
    const wait = this.waits.get(key);
    if (wait !== undefined && !wait.retry) {
      this.hold(key, delivery);
      return Promise.resolve({ outcome: "deferred", key, reason: wait.reason });
    }
    return this.attempt(key, delivery);
  }

  /** A waiting delivery retried off a pickup's turn: from its bytes, acknowledged when it ends; without its bytes, left for its next redelivery. */
  private async retry(key: string, wait: Wait): Promise<Received | null> {
    const delivery = this.held.get(key)?.delivery;
    if (delivery === undefined || this.closed) {
      wait.retry = true;
      return null;
    }
    let received: Received;
    try {
      received = await this.attempt(key, delivery);
    } catch (err) {
      if (err instanceof ReceiverClosed) return null;
      throw err;
    }
    if (received.outcome !== "deferred" && delivery.source.kind === "pickup" && this.options.acknowledge !== undefined) {
      try {
        await this.options.acknowledge(delivery.source);
        this.ended.delete(key);
      } catch (err) {
        this.log(`a delivery was ${received.outcome} but not acknowledged; the mediator delivers it again: ${messageOf(err)}`);
      }
    }
    return received;
  }

  private async attempt(key: string, delivery: Delivery): Promise<Received> {
    const observed = this.changes;
    const defer = (reason: string, watch: Watch, fold: VaultFold): Promise<Received> => this.defer(key, delivery, observed, { reason, watch, fold });
    let fold: VaultFold;
    try {
      fold = await scanVault(this.runtime.vault, this.keys);
    } catch (err) {
      this.refuseClosed();
      return this.leave(key, delivery, `the vault is not read: ${messageOf(err)}`);
    }
    this.refuseClosed();
    const header = envelopeHeader(delivery.packed);
    if (header.kind !== "authcrypt" && header.kind !== "anoncrypt") return this.finish(key, delivery, `not an envelope encrypted to its recipients (${header.kind})`);
    const recipients = classifyRecipients(fold, header.kids ?? []);
    if (recipients.verdict === "terminal") return this.finish(key, delivery, recipients.reason);
    if (recipients.verdict === "pending") return defer(recipients.reason, recipientWatch(recipients.waitingOn), fold);
    await this.ring.reload(fold);
    this.refuseClosed();
    const secrets: Secret[] = this.ring.secrets().filter((secret) => secret.id === recipients.kid);
    if (secrets.length === 0) return defer(`no key in hand for ${recipients.kid}`, recipientWatch([recipients.didId]), fold);

    const sender = await senderEvidence(fold, header.skid ?? null);
    if ("terminal" in sender) return this.finish(key, delivery, sender.terminal);
    const trace = this.options.trace ?? null;
    let unpacked;
    try {
      unpacked = await unpack(this.options.didcomm, delivery.packed, pinnedResolver(fold, { current: sender.resolution === null ? [] : [sender.resolution] }), secretsResolverFor(secrets));
    } catch (err) {
      await note(trace, { stream: "envelope", what: "error", data: { ...header, parent: delivery.parent, error: messageOf(err) } });
      this.refuseClosed();
      return this.finish(key, delivery, `the envelope does not open: ${messageOf(err)}`);
    }
    const proof = senderProof(unpacked, sealingOf(delivery.packed), sender.resolution);
    await note(trace, { stream: "envelope", what: "open", data: { ...header, parent: delivery.parent, type: unpacked.plaintext.type, from_prior: unpacked.fromPrior !== null } });
    this.refuseClosed();
    if ("refused" in proof) return this.finish(key, delivery, proof.refused);
    if (proof.sender !== null && sameDid(proof.sender.resolution.did, recipients.did)) return this.finish(key, delivery, `the sender ${proof.sender.resolution.did} is the recipient itself`);
    const refused = this.options.admit?.({ source: delivery.source, recipient: recipients.did, sender: proof.sender?.resolution.did ?? null, bytes: utf8.encode(delivery.packed).length }) ?? null;
    if (refused !== null) return this.finish(key, delivery, refused);

    const authenticated: Authenticated = {
      delivery,
      plaintext: unpacked.plaintext,
      metadata: unpacked.metadata,
      recipient: { didId: recipients.didId, did: recipients.did, kid: recipients.kid, localKeyName: recipients.localKeyName },
      sender: proof.sender,
      fromPrior: unpacked.fromPrior,
    };
    let outcome: ReceiptOutcome;
    try {
      outcome = await this.options.receipt(authenticated);
    } catch (err) {
      return this.leave(key, delivery, `the receipt failed: ${messageOf(err)}`);
    }
    switch (outcome.outcome) {
      case "received":
        return this.record(key, delivery, outcome.cid, outcome.first);
      case "terminal":
        return this.finish(key, delivery, outcome.reason);
      case "deferred":
        return defer(outcome.reason, outcome.watch, fold);
    }
  }

  /**
   * A delivery that waits, held with what it waits for. A local change
   * told of while the attempt read the vault may have changed that: the
   * vault is read again, and only when the watch says something else
   * does the delivery go through the gate again. Past as many as may
   * wait, it is left where it came from instead.
   */
  private async defer(key: string, delivery: Delivery, observed: number, deferral: { reason: string; watch: Watch; fold: VaultFold }): Promise<Received> {
    const reason = bounded(deferral.reason);
    const { watch } = deferral;
    const seen = watch(deferral.fold);
    while (!this.closed && this.changes !== observed) {
      observed = this.changes;
      const fold = await this.foldOrNull();
      if (fold === null) return this.leave(key, delivery, "the vault is not read to tell what changed");
      if (watch(fold) !== seen) return this.attempt(key, delivery);
    }
    if (this.closed) return this.leave(key, delivery, reason);
    if (!this.waits.has(key) && this.waits.size >= this.maxWaiting) return this.leave(key, delivery, `${reason}; as many deliveries wait as may`);
    this.hold(key, delivery);
    this.waits.set(key, { source: delivery.source, reason, watch, seen, retry: false });
    await this.diag(delivery, { outcome: "deferred", reason });
    return { outcome: "deferred", key, reason };
  }

  /** A delivery not kept: a wait it had is let go with its bytes, and it comes again from where it came. */
  private async leave(key: string, delivery: Pick<Delivery, "source" | "parent">, reason: string): Promise<Received> {
    this.waits.delete(key);
    this.release(key);
    const left = bounded(`${reason}; the delivery is left where it came from`);
    await this.diag(delivery, { outcome: "deferred", reason: left });
    return { outcome: "deferred", key, reason: left };
  }

  private async record(key: string, delivery: Delivery, cid: EventReference<"message.in">, live: boolean): Promise<Received> {
    this.waits.delete(key);
    this.release(key);
    const ended: Ended = { outcome: "received", key, cid, live };
    if (!this.closed) this.remember(key, ended);
    await this.diag(delivery, { outcome: "received", cid });
    return ended;
  }

  private async finish(key: string, delivery: Delivery, reason: string): Promise<Received> {
    this.waits.delete(key);
    this.release(key);
    const ended: Ended = { outcome: "terminal", key, reason: bounded(reason) };
    if (!this.closed) this.remember(key, ended);
    await this.discard(delivery, reason);
    return ended;
  }

  private remember(key: string, ended: Ended): void {
    this.ended.delete(key);
    this.ended.set(key, ended);
    for (const oldest of this.ended.keys()) {
      if (this.ended.size <= ENDED_KEPT) break;
      this.ended.delete(oldest);
    }
  }

  /** Holds a delivery's bytes while everything held fits; without them, it is opened again only at its next redelivery. */
  private hold(key: string, delivery: Delivery): void {
    if (this.held.has(key)) return;
    const bytes = utf8.encode(delivery.packed).length;
    if (this.heldBytes + bytes > this.maxHeldBytes) return;
    this.held.set(key, { delivery, bytes });
    this.heldBytes += bytes;
  }

  private release(key: string): void {
    const held = this.held.get(key);
    if (held === undefined) return;
    this.held.delete(key);
    this.heldBytes -= held.bytes;
  }

  private discard(delivery: Delivery, reason: string): Promise<unknown> {
    const kept = bounded(reason);
    if (!this.closed) {
      this.discardedRing.push({ source: delivery.source, reason: kept });
      if (this.discardedRing.length > DISCARDED_KEPT) this.discardedRing.shift();
    }
    return this.diag(delivery, { outcome: "terminal", reason: kept });
  }

  private diag(delivery: Pick<Delivery, "source" | "parent">, data: TraceData): Promise<unknown> {
    const { source } = delivery;
    const via: TraceData = source.kind === "pickup" ? { via: "pickup", mediationId: source.mediationId, deliveryId: source.deliveryId } : { via: "direct" };
    return note(this.options.trace ?? null, { stream: "diag", what: "receive", data: { ...via, parent: delivery.parent, ...data } });
  }
}

/** Watches what keeps each of these entities from receiving: a delivery waiting on them is retried when that changes for any of them. */
export function recipientWatch(didIds: readonly DidId[]): Watch {
  return (fold) => JSON.stringify(didIds.map((didId) => [fold.routes.receipt(didId), fold.routes.dids.get(didId)?.faults ?? null]));
}

function bounded(reason: string): string {
  return reason.length <= REASON_KEPT ? reason : `${reason.slice(0, REASON_KEPT)}…`;
}

/**
 * The key a delivery is kept under: a pickup attachment by its
 * arrangement and attachment ID, a direct post by the CID of its
 * canonical envelope, so that one envelope posted twice is one delivery
 * however its JSON was spaced. Null for a direct post that is not strict
 * JSON.
 */
export function deliveryKey(delivery: Delivery): string | null {
  const { source } = delivery;
  if (source.kind === "pickup") return pickupKey(source.mediationId, source.deliveryId);
  try {
    return JSON.stringify(["direct", rawCidOfBytes(canonicalize(parseStrict(utf8.encode(delivery.packed))))]);
  } catch {
    return null;
  }
}

function pickupKey(mediationId: MediationId, deliveryId: string): string {
  return JSON.stringify(["pickup", mediationId, deliveryId]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
