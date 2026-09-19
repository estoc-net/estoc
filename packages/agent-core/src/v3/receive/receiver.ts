/**
 * Every delivery this runtime is handed — an attachment the mediator
 * delivered, or an envelope posted straight to it — goes through one
 * gate before anything reaches the vault. The recipients it names
 * decide first: a delivery this vault may never open is terminal, one
 * waiting on something recoverable of this runtime's is held. It is
 * then opened with the one key it may be opened with, its sender read
 * from what the vault holds and nothing else, and what the envelope
 * proves checked; what passes goes to the receipt, which records it or
 * says what of this runtime's it still waits for. A terminal delivery
 * is acknowledged to the mediator and leaves nothing in the vault, only
 * a bounded diagnostic here and in the trace: what it lacked, without a
 * claimed sender presented as anyone, and without a cause asserted.
 *
 * A runtime receives through one receiver at a time, so that every way
 * a delivery arrives — a pickup's drain, the socket, a direct post, a
 * retry after a local change — shares what is kept of it. That is in
 * memory only: why it waits, its bytes while they fit, and how it ended
 * until the mediator is told. A delivery that ended is not opened again
 * when it comes again, only told again, so that a lost acknowledgement
 * costs no second opening; a direct post, which no one acknowledges, is
 * remembered until newer ones push it out. A delivery that waits is not
 * opened again when it is redelivered: only a change of this runtime's
 * own state retries it, from the bytes held or at the next redelivery,
 * and one retried off a pickup's turn is acknowledged through
 * `acknowledge` once it is received or found terminal. Nothing here
 * waits for the network or for evidence about a peer: a sender the
 * vault cannot authenticate now is refused now.
 */

import type { Secret } from "@estoc/did-peer";
import { canonicalize, parseStrict, type VaultRuntime } from "@estoc/event-store/v3";
import { rawCidOfBytes, scanVault, type Did, type DidId, type DidUrl, type Keys, type KeyName, type MediationId, type VaultFold } from "@estoc/vault/v3";

import { secretsResolverFor, unpack, type DidcommApi, type IMessage, type UnpackMetadata } from "../../protocol/didcomm.js";
import { envelopeHeader } from "../../protocol/envelope.js";
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

/** A delivery the gate let through, for the receipt. */
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

/** What the receipt made of an authenticated delivery: recorded, which ends it; terminal; or held for something of this runtime's that is not ready. */
export type ReceiptOutcome = { outcome: "received" } | { outcome: "terminal"; reason: string } | { outcome: "deferred"; reason: string };

export type Receipt = (authenticated: Authenticated) => Promise<ReceiptOutcome>;

/** What became of a delivery. `key` is what it is kept under; null only for a direct post that is not strict JSON. */
export type Received = { outcome: "received"; key: string } | { outcome: "terminal"; key: string | null; reason: string } | { outcome: "deferred"; key: string; reason: string };

/** A held delivery, for display. */
export interface WaitingDelivery {
  key: string;
  source: Source;
  reason: string;
  /** whether its bytes are held, so a retry needs no redelivery */
  held: boolean;
}

/** A delivery found terminal: what it lacked, for the user to see. */
export interface Discarded {
  source: Source;
  reason: string;
}

/** What the ingress limits are asked about, once a delivery is authenticated and before it is recorded. */
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
  /** the most envelope bytes held for retries, all deliveries together */
  maxHeldBytes?: number;
  trace?: AgentTrace;
  log?: (line: string) => void;
}

export const MAX_HELD_BYTES = 16 * 1024 * 1024;

/** How many ended deliveries are remembered at once; past it the oldest is forgotten, and comes again as a new delivery. */
export const ENDED_KEPT = 1024;

/** How many discarded deliveries are kept for display; past it the oldest is forgotten. */
export const DISCARDED_KEPT = 256;

interface Wait {
  source: Source;
  reason: string;
  /** the local state changed while no bytes were held: the next redelivery is opened */
  retry: boolean;
}

type Ended = Exclude<Received, { outcome: "deferred" }>;

const utf8 = new TextEncoder();

const receivers = new WeakMap<VaultRuntime, Receiver>();

export class Receiver {
  private readonly log: (line: string) => void;
  private readonly maxHeldBytes: number;
  private readonly waits = new Map<string, Wait>();
  private readonly held = new Map<string, Delivery>();
  private heldBytes = 0;
  private readonly ended = new Map<string, Ended>();
  private readonly discardedRing: Discarded[] = [];
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

  /** Something of this runtime's may be ready now: every held delivery is retried from its bytes, and one whose bytes are not held is opened at its next redelivery. */
  async localStateChanged(): Promise<Received[]> {
    const results: Received[] = [];
    for (const [key, wait] of [...this.waits]) {
      if (this.closed) break;
      const received = await this.retryInTurn(key, wait);
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

  private retryInTurn(key: string, wait: Wait): Promise<Received | null> {
    return this.inTurn(key, () => (this.waits.get(key) === wait ? this.retry(key, wait) : Promise.resolve(null)));
  }

  private enter(key: string, delivery: Delivery): Promise<Received> {
    this.refuseClosed();
    const ended = this.ended.get(key);
    if (ended !== undefined) return Promise.resolve(ended);
    const wait = this.waits.get(key);
    if (wait !== undefined && !wait.retry) {
      this.hold(key, delivery);
      return Promise.resolve({ outcome: "deferred", key, reason: wait.reason });
    }
    return this.attempt(key, delivery);
  }

  /** A held delivery retried off a pickup's turn: from its bytes, acknowledged when it ends; without its bytes, left for its next redelivery. */
  private async retry(key: string, wait: Wait): Promise<Received | null> {
    const delivery = this.held.get(key);
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
    let fold: VaultFold;
    try {
      fold = await scanVault(this.runtime.vault, this.keys);
    } catch (err) {
      this.refuseClosed();
      return this.defer(key, delivery, `the vault is not read: ${messageOf(err)}`);
    }
    this.refuseClosed();
    const header = envelopeHeader(delivery.packed);
    if (header.kind !== "authcrypt" && header.kind !== "anoncrypt") return this.finish(key, delivery, `not an envelope encrypted to its recipients (${header.kind})`);
    const recipients = classifyRecipients(fold, header.kids ?? []);
    if (recipients.verdict === "terminal") return this.finish(key, delivery, recipients.reason);
    if (recipients.verdict === "pending") return this.defer(key, delivery, recipients.reason);
    await this.ring.reload(fold);
    this.refuseClosed();
    const secrets: Secret[] = this.ring.secrets().filter((secret) => secret.id === recipients.kid);
    if (secrets.length === 0) return this.defer(key, delivery, `no key in hand for ${recipients.kid}`);

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
      return this.defer(key, delivery, `the receipt failed: ${messageOf(err)}`);
    }
    switch (outcome.outcome) {
      case "received":
        return this.finish(key, delivery, null);
      case "terminal":
        return this.finish(key, delivery, outcome.reason);
      case "deferred":
        return this.defer(key, delivery, outcome.reason);
    }
  }

  private async defer(key: string, delivery: Delivery, reason: string): Promise<Received> {
    if (!this.closed) {
      this.hold(key, delivery);
      this.waits.set(key, { source: delivery.source, reason, retry: false });
    }
    await this.diag(delivery, { outcome: "deferred", reason });
    return { outcome: "deferred", key, reason };
  }

  private async finish(key: string, delivery: Delivery, reason: string | null): Promise<Received> {
    this.waits.delete(key);
    this.release(key);
    const ended: Ended = reason === null ? { outcome: "received", key } : { outcome: "terminal", key, reason };
    if (!this.closed) this.remember(key, ended);
    if (reason === null) await this.diag(delivery, { outcome: "received" });
    else await this.discard(delivery, reason);
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
    const size = delivery.packed.length;
    if (this.heldBytes + size > this.maxHeldBytes) return;
    this.held.set(key, delivery);
    this.heldBytes += size;
  }

  private release(key: string): void {
    const delivery = this.held.get(key);
    if (delivery === undefined) return;
    this.held.delete(key);
    this.heldBytes -= delivery.packed.length;
  }

  /** A terminal delivery: kept for display, as many as are kept, and traced. */
  private discard(delivery: Delivery, reason: string): Promise<unknown> {
    if (!this.closed) {
      this.discardedRing.push({ source: delivery.source, reason });
      if (this.discardedRing.length > DISCARDED_KEPT) this.discardedRing.shift();
    }
    return this.diag(delivery, { outcome: "terminal", reason });
  }

  private diag(delivery: Delivery, data: TraceData): Promise<unknown> {
    const { source } = delivery;
    const via: TraceData = source.kind === "pickup" ? { via: "pickup", mediationId: source.mediationId, deliveryId: source.deliveryId } : { via: "direct" };
    return note(this.options.trace ?? null, { stream: "diag", what: "receive", data: { ...via, parent: delivery.parent, ...data } });
  }
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
