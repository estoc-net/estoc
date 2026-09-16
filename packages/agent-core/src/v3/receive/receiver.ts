/**
 * Every delivery this runtime is handed — an attachment the mediator
 * delivered, or an envelope posted straight to it — goes through one
 * gate before anything reaches the vault. The recipients it names
 * decide first: a delivery this vault may never open is terminal, one
 * waiting on something recoverable is held. It is then opened with the
 * one key it may be opened with, its sender resolved for this delivery
 * alone, and what it proves checked; what passes goes to the receipt,
 * which records it or says what it waits for.
 *
 * A runtime receives through one receiver at a time, so that every way
 * a delivery arrives — a pickup's drain, the socket, a direct post, a
 * retry at a timer or after a change — shares what is kept of it. That
 * is in memory only: why it waits, its bytes while they fit, the
 * accounting of its sender's resolution, and how it ended until the
 * mediator is told. A delivery that ended is not opened again when it
 * comes again, only told again, so that a lost acknowledgement costs no
 * second resolution; a direct post, which no one acknowledges, is
 * remembered until newer ones push it out.
 *
 * The accounting is per delivery, and a redelivery neither resets it nor
 * calls the resolver before the next call is due; the call is made on
 * time without one, from the bytes held. Those bytes are held before any
 * other delivery's, and a delivery whose bytes cannot be held for its
 * next call is terminal: retrying it would take more than this runtime
 * holds. A delivery waiting for relationship evidence, or for a document
 * its `from_prior` issuer needs, is not opened again when it is
 * redelivered: only a change in that evidence retries it, with a fresh
 * resolution when its sender needs one. A delivery retried off a
 * pickup's turn — at a timer, or after a change — is acknowledged
 * through `acknowledge` once it is received or found terminal.
 */

import type { Secret } from "@estoc/did-peer";
import { DIDDocConversionError, type DIDDoc } from "@estoc/did-peer";
import { canonicalize, parseStrict, type VaultRuntime } from "@estoc/event-store/v3";
import { InvalidDidDocument, InvalidPublicKey, canonicalDidOf, objectReader, rawCidOfBytes, scanVault, type Did, type DidId, type DidUrl, type Keys, type KeyName, type MediationId, type VaultFold } from "@estoc/vault/v3";

import { didOf, secretsResolverFor, unpackMessage, type DIDResolver, type DidcommApi, type IMessage, type UnpackMetadata } from "../../protocol/didcomm.js";
import { envelopeHeader } from "../../protocol/envelope.js";
import { ReceiverClosed, ReceiverInUse } from "../errors.js";
import { didcommDocumentOf, pinnedResolution, pinnedResolver } from "../evidence.js";
import type { Keyring } from "../keyring.js";
import { GLOBAL_TIMERS, LONGEST_TIMER_MS, type Timers } from "../outbox.js";
import type { Delivered, Fate, Handle } from "../pickup.js";
import { serially } from "../procedure.js";
import { DEFAULT_TIMEOUT_MS, knownLongForms, resolve, type KnownLongForms, type Resolution, type Resolved, type ResolverOptions } from "../resolver.js";
import { note, type TraceData } from "../trace.js";
import { RESOLUTION_POLICY, ResolutionSequence, type ResolutionPolicy, type Retention } from "./accounting.js";
import { classifyRecipients, evidenceOf, sealingOf, senderProof, type AuthenticatedSender, type Dependency } from "./gate.js";

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
  /** null for an anonymous sender */
  sender: AuthenticatedSender | null;
  fromPrior: { iss: string; sub: string; jwt: string } | null;
}

/**
 * What the receipt made of an authenticated delivery: recorded, which
 * ends it; terminal; waiting for evidence the vault does not hold,
 * naming everything its decision read, so that a change in any of it
 * retries the delivery; or held for something of this runtime's that
 * is not ready.
 */
export type ReceiptOutcome =
  | { outcome: "received" }
  | { outcome: "terminal"; reason: string }
  | { outcome: "wait"; reason: string; dependencies: readonly Dependency[] }
  | { outcome: "deferred"; reason: string };

export type Receipt = (authenticated: Authenticated) => Promise<ReceiptOutcome>;

/**
 * What a held delivery waits for: `local`, something of this runtime's
 * — the vault, a recipient's route or key check; `resolution`, its
 * sender's next resolution; `relationship`, evidence the vault does
 * not hold yet — which relationship an address pair belongs to, or
 * which relationship took an invitation; `history`, a document it
 * names that no evidence holds.
 */
export type WaitKind = "local" | "resolution" | "relationship" | "history";

/** What became of a delivery. `key` is its accounting key; null only for a direct post that is not strict JSON. */
export type Received = { outcome: "received"; key: string } | { outcome: "terminal"; key: string | null; reason: string } | { outcome: "deferred"; key: string; wait: WaitKind; reason: string };

/** A held delivery, for display. */
export interface Waiting {
  key: string;
  source: Source;
  wait: WaitKind;
  reason: string;
  /** resolutions counted in its current sequence */
  attempts: number;
  /** when its next resolution is due, while one waits */
  retryAt: number | null;
  /** whether its bytes are held, so a retry needs no redelivery */
  held: boolean;
}

export interface ReceiverOptions extends ResolverOptions {
  didcomm: DidcommApi;
  receipt: Receipt;
  /** acknowledges a pickup delivery retried off a pickup's turn */
  acknowledge?: (source: Extract<Source, { kind: "pickup" }>) => Promise<void>;
  /** what the mediator says of how long it keeps a delivery; unknown by default */
  retention?: (source: Source) => Retention;
  policy?: Partial<ResolutionPolicy>;
  /** what a wait for relationship evidence is retried on a change of; `evidenceOf` by default */
  evidenceOf?: (fold: VaultFold, dependencies: readonly Dependency[]) => string;
  /** the most envelope bytes held for retries, all deliveries together */
  maxHeldBytes?: number;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
}

export const MAX_HELD_BYTES = 16 * 1024 * 1024;

/** How many ended deliveries are remembered at once; past it the oldest is forgotten, and comes again as a new delivery. */
export const ENDED_KEPT = 1024;

type Wait =
  | { kind: "local" | "resolution"; source: Source; reason: string }
  | { kind: "relationship"; source: Source; reason: string; dependencies: readonly Dependency[]; evidence: string; retry: boolean }
  | { kind: "history"; source: Source; reason: string; localDid: Did; did: string; retry: boolean };

type Ended = Exclude<Received, { outcome: "deferred" }>;

/** What the resolver was asked while an envelope opened: the sender's answer, and every other DID no evidence held. */
interface Asked {
  sender: { did: string; answer: Resolved } | null;
  missing: string[];
}

const WEB = /^did:web:/;
const utf8 = new TextEncoder();

const receivers = new WeakMap<VaultRuntime, Receiver>();

export class Receiver {
  private readonly policy: ResolutionPolicy;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly evidenceOf: (fold: VaultFold, dependencies: readonly Dependency[]) => string;
  private readonly maxHeldBytes: number;
  private readonly waits = new Map<string, Wait>();
  private readonly sequences = new Map<string, ResolutionSequence>();
  private readonly held = new Map<string, Delivery>();
  private heldBytes = 0;
  private readonly ended = new Map<string, Ended>();
  private readonly wakes = new Map<string, unknown>();
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
    this.policy = { ...RESOLUTION_POLICY, ...options.policy };
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.evidenceOf = options.evidenceOf ?? evidenceOf;
    this.maxHeldBytes = options.maxHeldBytes ?? MAX_HELD_BYTES;
  }

  /** One delivery through the gate, in turn with every other step for the same delivery. */
  async receive(delivery: Delivery): Promise<Received> {
    this.refuseClosed();
    const key = deliveryKey(delivery);
    if (key === null) {
      const reason = "the envelope is not strict JSON";
      await this.diag(delivery, { outcome: "terminal", reason });
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
   * Evidence may have changed: every delivery waiting for relationship
   * evidence whose pair's evidence did change, and every one waiting for
   * a document the evidence now holds, is retried — from its bytes when
   * they are held, otherwise at its next redelivery.
   */
  async evidenceChanged(): Promise<Received[]> {
    if (this.closed) return [];
    const fold = await scanVault(this.runtime.vault, this.keys);
    const results: Received[] = [];
    for (const [key, wait] of [...this.waits]) {
      if (this.closed) break;
      if (!(await this.changed(fold, wait))) continue;
      const received = await this.retryInTurn(key, wait);
      if (received !== null) results.push(received);
    }
    return results;
  }

  /** Whether what an evidence wait waits on is different in `fold`; a wait for anything else is not retried on evidence. */
  private async changed(fold: VaultFold, wait: Wait): Promise<boolean> {
    switch (wait.kind) {
      case "relationship":
        return this.evidenceOf(fold, wait.dependencies) !== wait.evidence;
      case "history":
        return (await this.fromEvidence(fold, wait.localDid, wait.did, [])) !== null;
      default:
        return false;
    }
  }

  /** Something of this runtime's may be ready now: every delivery held for it is retried from its bytes. */
  async localStateChanged(): Promise<Received[]> {
    const results: Received[] = [];
    for (const [key, wait] of [...this.waits]) {
      if (this.closed) break;
      if (wait.kind !== "local") continue;
      const received = await this.retryInTurn(key, wait);
      if (received !== null) results.push(received);
    }
    return results;
  }

  waiting(): Waiting[] {
    return [...this.waits].map(([key, wait]) => {
      const sequence = this.sequences.get(key);
      return { key, source: wait.source, wait: wait.kind, reason: wait.reason, attempts: sequence?.attempts ?? 0, retryAt: sequence?.nextAt ?? null, held: this.held.has(key) };
    });
  }

  /**
   * No delivery is handed to the receipt after this.
   * One not yet handed to the receipt — waiting its turn, or with its
   * vault read, resolution or opening still under way, however that then
   * ends — is refused with `ReceiverClosed` and stays wherever it came
   * from; its sender's accounting went with this receiver and is not
   * taken to be spent. One whose receipt was already called ends as the
   * receipt says, since the receipt may have recorded it. Every timer is
   * cancelled and everything kept is let go; the runtime may then have
   * another receiver.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.wakes.values()) this.timers.clear(handle);
    this.wakes.clear();
    this.waits.clear();
    this.sequences.clear();
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
    if ((wait?.kind === "relationship" || wait?.kind === "history") && !wait.retry) {
      this.hold(key, delivery, wait.kind);
      return Promise.resolve({ outcome: "deferred", key, wait: wait.kind, reason: wait.reason });
    }
    return this.attempt(key, delivery);
  }

  /** A held delivery retried off a pickup's turn: from its bytes, acknowledged when it ends; without its bytes, left for its next redelivery. */
  private async retry(key: string, wait: Wait): Promise<Received | null> {
    const delivery = this.held.get(key);
    if (delivery === undefined || this.closed) {
      if (wait.kind === "relationship" || wait.kind === "history") wait.retry = true;
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
    const now = this.now();
    let fold: VaultFold;
    try {
      fold = await scanVault(this.runtime.vault, this.keys);
    } catch (err) {
      this.refuseClosed();
      return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: `the vault is not read: ${messageOf(err)}` });
    }
    this.refuseClosed();
    const header = envelopeHeader(delivery.packed);
    if (header.kind !== "authcrypt" && header.kind !== "anoncrypt") return this.finish(key, delivery, `not an envelope encrypted to its recipients (${header.kind})`);
    const recipients = classifyRecipients(fold, header.kids ?? []);
    if (recipients.verdict === "terminal") return this.finish(key, delivery, recipients.reason);
    if (recipients.verdict === "pending") return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: recipients.reason });
    await this.ring.reload(fold);
    this.refuseClosed();
    const secrets: Secret[] = this.ring.secrets().filter((secret) => secret.id === recipients.kid);
    if (secrets.length === 0) return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: `no key in hand for ${recipients.kid}` });

    const sequence = this.sequences.get(key);
    if (sequence !== undefined) {
      sequence.resume(now);
      const stopped = sequence.stopped(now);
      if (stopped !== null) return this.finish(key, delivery, `the sender is not resolved: ${stopped}`);
      if (!sequence.due(now)) {
        this.schedule(key, sequence.wake(now));
        return this.defer(key, delivery, { kind: "resolution", source: delivery.source, reason: `the sender's next resolution is due at ${new Date(sequence.nextAt as number).toISOString()}` });
      }
    }

    const asked: Asked = { sender: null, missing: [] };
    const sealing = sealingOf(delivery.packed);
    let plaintext: IMessage;
    let metadata: UnpackMetadata;
    try {
      [plaintext, metadata] = await unpackMessage(this.options.didcomm, delivery.packed, this.resolverFor(key, delivery.source, fold, recipients.did, sealing.skid, asked), secretsResolverFor(secrets), {});
    } catch (err) {
      await note(this.options.trace ?? null, { stream: "envelope", what: "error", data: { ...header, parent: delivery.parent, error: messageOf(err) } });
      this.refuseClosed();
      return this.unopened(key, delivery, recipients.did, asked, err);
    }
    const resolution = asked.sender?.answer.outcome === "resolved" ? asked.sender.answer.resolution : null;
    const proof = senderProof(plaintext, metadata, sealing, resolution);
    this.sequences.delete(key);
    const rotation = metadata.from_prior ?? null;
    await note(this.options.trace ?? null, { stream: "envelope", what: "open", data: { ...header, parent: delivery.parent, type: plaintext.type, ...(rotation === null ? {} : { from_prior: { iss: rotation.iss, sub: rotation.sub } }) } });
    this.refuseClosed();
    if ("refused" in proof) return this.finish(key, delivery, proof.refused);

    const authenticated: Authenticated = {
      delivery,
      plaintext,
      metadata,
      recipient: { didId: recipients.didId, did: recipients.did, kid: recipients.kid, localKeyName: recipients.localKeyName },
      sender: proof.sender,
      fromPrior: rotation === null ? null : { iss: rotation.iss, sub: rotation.sub, jwt: plaintext.from_prior as string },
    };
    let outcome: ReceiptOutcome;
    try {
      outcome = await this.options.receipt(authenticated);
    } catch (err) {
      return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: `the receipt failed: ${messageOf(err)}` });
    }
    switch (outcome.outcome) {
      case "received":
        return this.finish(key, delivery, null);
      case "terminal":
        return this.finish(key, delivery, outcome.reason);
      case "deferred":
        return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: outcome.reason });
      case "wait":
        return this.defer(key, delivery, { kind: "relationship", source: delivery.source, reason: outcome.reason, dependencies: outcome.dependencies, evidence: this.evidenceOf(fold, outcome.dependencies), retry: false });
    }
  }

  /** An envelope to `localDid` that did not open: why, as far as what the resolver was asked tells. */
  private unopened(key: string, delivery: Delivery, localDid: Did, asked: Asked, err: unknown): Promise<Received> {
    const sender = asked.sender;
    if (sender?.answer.outcome === "unavailable") {
      const now = this.now();
      const sequence = this.sequences.get(key);
      const stopped = sequence === undefined ? "no sequence" : sequence.stopped(now);
      if (sequence === undefined || stopped !== null) return this.finish(key, delivery, `${sender.did} is not resolved: ${stopped}; the last answer: ${sender.answer.reason}`);
      this.schedule(key, sequence.unavailable(now));
      return this.defer(key, delivery, { kind: "resolution", source: delivery.source, reason: `${sender.did} is not resolved now: ${sender.answer.reason}` });
    }
    if (sender?.answer.outcome === "definitive") return this.finish(key, delivery, `${sender.did} does not resolve: ${sender.answer.reason}`);
    const [missing] = asked.missing;
    if (sender?.answer.outcome === "resolved" && missing !== undefined) {
      this.sequences.delete(key);
      return this.defer(key, delivery, { kind: "history", source: delivery.source, reason: `the envelope names ${missing}, whose document no evidence holds`, localDid, did: missing, retry: false });
    }
    return this.finish(key, delivery, `the envelope does not open: ${messageOf(err)}`);
  }

  /**
   * The resolver an envelope to `localDid` opens with. The first DID
   * asked — the one the header names as sealing it, when it names one —
   * is the sender's, resolved for this delivery: a `did:web` over the
   * network, counted before the call. Every other DID, a `from_prior`
   * issuer's among them, is answered only from evidence.
   */
  private resolverFor(key: string, source: Source, fold: VaultFold, localDid: Did, skid: string | null, asked: Asked): DIDResolver {
    const senderDid = skid === null ? null : didOf(skid);
    const known = knownLongForms(fold);
    return {
      resolve: async (did: string): Promise<DIDDoc | null> => {
        if (this.closed) return null;
        if (asked.sender === null && (senderDid === null || did === senderDid)) {
          asked.sender = { did, answer: await this.resolveSender(key, source, did, known) };
        }
        const sender = asked.sender;
        if (sender?.did === did) {
          if (sender.answer.outcome !== "resolved") return null;
          try {
            return didcommDocumentOf(sender.answer.resolution, did);
          } catch (err) {
            if (!(err instanceof InvalidDidDocument || err instanceof InvalidPublicKey || err instanceof DIDDocConversionError)) throw err;
            sender.answer = { outcome: "definitive", reason: `the document does not read as DIDComm's: ${messageOf(err)}` };
            return null;
          }
        }
        const document = await this.fromEvidence(fold, localDid, did, sender?.answer.outcome === "resolved" ? [sender.answer.resolution] : []);
        if (document === null) asked.missing.push(did);
        return document;
      },
    };
  }

  /**
   * A DID other than the sender's, as evidence answers it at `localDid`:
   * from this delivery's resolutions and what the vault holds, and for a
   * `from_prior` issuer, from the snapshot pinned by the one relationship
   * holding `localDid` and that DID in its histories. Another
   * relationship's snapshot of the same DID is never taken for it.
   */
  private async fromEvidence(fold: VaultFold, localDid: Did, did: string, current: Resolution[]): Promise<DIDDoc | null> {
    let peerDid: Did;
    try {
      peerDid = canonicalDidOf(did);
    } catch (err) {
      if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return null;
      throw err;
    }
    const [relationshipId, ...others] = fold.relationships.claimants(localDid, peerDid);
    const pinned = relationshipId === undefined || others.length > 0 ? null : await pinnedResolution(fold, objectReader(this.runtime.vault.objects), relationshipId, peerDid);
    return pinnedResolver(fold, { current, pinned: pinned === null ? [] : [pinned] }).resolve(did);
  }

  /**
   * The sender's DID resolved for this delivery. A `did:web` goes over
   * the network, counted before the call, and the call is cut when the
   * retention stop comes: a document that arrives after it is not taken.
   */
  private async resolveSender(key: string, source: Source, did: string, known: KnownLongForms): Promise<Resolved> {
    if (!WEB.test(did)) return resolve(did, known, this.options);
    let sequence = this.sequences.get(key);
    if (sequence === undefined) {
      sequence = new ResolutionSequence(this.policy, this.now(), this.options.retention?.(source) ?? {});
      this.sequences.set(key, sequence);
    }
    sequence.count();
    const left = sequence.remaining(this.now());
    const answer = await resolve(did, known, left === null ? this.options : { ...this.options, timeoutMs: Math.min(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS, left) });
    if (answer.outcome !== "resolved" || sequence.pastStop(this.now()) === null) return answer;
    return { outcome: "unavailable", reason: "resolved only after the retention stop" };
  }

  private async defer(key: string, delivery: Delivery, wait: Wait): Promise<Received> {
    if (wait.kind !== "resolution") {
      this.sequences.get(key)?.suspend(this.now());
      this.cancel(key);
    }
    if (!this.closed) {
      if (!this.hold(key, delivery, wait.kind) && wait.kind === "resolution") {
        return this.finish(key, delivery, `no room to hold its ${delivery.packed.length} bytes for its sender's next resolution: ${this.heldBytes} of the ${this.maxHeldBytes} bytes held are for other deliveries waiting on theirs`);
      }
      this.waits.set(key, wait);
    }
    await this.diag(delivery, { outcome: "deferred", wait: wait.kind, reason: wait.reason, attempts: this.sequences.get(key)?.attempts });
    return { outcome: "deferred", key, wait: wait.kind, reason: wait.reason };
  }

  private async finish(key: string, delivery: Delivery, reason: string | null): Promise<Received> {
    this.waits.delete(key);
    this.sequences.delete(key);
    this.release(key);
    this.cancel(key);
    const ended: Ended = reason === null ? { outcome: "received", key } : { outcome: "terminal", key, reason };
    if (!this.closed) this.remember(key, ended);
    await this.diag(delivery, reason === null ? { outcome: "received" } : { outcome: "terminal", reason });
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

  /**
   * Holds a delivery's bytes while everything held fits. A delivery
   * waiting for its sender's next resolution needs them when its call
   * comes due, so the bytes of deliveries waiting for anything else are
   * let go, oldest first, to make room for it: those are retried on a
   * change, and are given again at their next redelivery.
   */
  private hold(key: string, delivery: Delivery, kind: WaitKind): boolean {
    if (this.held.has(key)) return true;
    const size = delivery.packed.length;
    if (kind === "resolution") {
      for (const other of [...this.held.keys()]) {
        if (this.heldBytes + size <= this.maxHeldBytes) break;
        if (this.waits.get(other)?.kind !== "resolution") this.release(other);
      }
    }
    if (this.heldBytes + size > this.maxHeldBytes) return false;
    this.held.set(key, delivery);
    this.heldBytes += size;
    return true;
  }

  private release(key: string): void {
    const delivery = this.held.get(key);
    if (delivery === undefined) return;
    this.held.delete(key);
    this.heldBytes -= delivery.packed.length;
  }

  /** One timer per delivery, for when its sequence is looked at again; a wake further off than a timer takes is reached in steps. */
  private schedule(key: string, at: number | null): void {
    this.cancel(key);
    if (this.closed || at === null) return;
    const handle = this.timers.set(
      () => {
        this.wakes.delete(key);
        const wait = this.waits.get(key);
        if (wait === undefined) return;
        this.retryInTurn(key, wait).catch((err: unknown) => this.log(`a held delivery was not retried: ${messageOf(err)}`));
      },
      Math.min(LONGEST_TIMER_MS, Math.max(0, at - this.now()))
    );
    this.wakes.set(key, handle);
  }

  private cancel(key: string): void {
    const handle = this.wakes.get(key);
    if (handle === undefined) return;
    this.timers.clear(handle);
    this.wakes.delete(key);
  }

  private diag(delivery: Delivery, data: TraceData): Promise<unknown> {
    const { source } = delivery;
    const via: TraceData = source.kind === "pickup" ? { via: "pickup", mediationId: source.mediationId, deliveryId: source.deliveryId } : { via: "direct" };
    return note(this.options.trace ?? null, { stream: "diag", what: "receive", data: { ...via, parent: delivery.parent, ...data } });
  }
}

/**
 * The key a delivery's accounting is kept under: a pickup attachment by
 * its arrangement and attachment ID, a direct post by the CID of its
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
