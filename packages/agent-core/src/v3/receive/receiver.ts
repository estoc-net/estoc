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
 * A terminal delivery is told to the caller, which acknowledges a
 * pickup; a held one is not, and stays with the mediator. What this
 * runtime keeps of a held delivery is in memory only: why it waits, its
 * bytes while they fit, and, while its sender does not resolve now, the
 * accounting of that resolution. That accounting is per delivery, and
 * a redelivery neither resets it nor calls the resolver before the next
 * call is due; the call is made on time without one, from the bytes
 * held. A delivery waiting for relationship evidence, or for a document
 * its `from_prior` issuer needs, is not opened again when it is
 * redelivered: only a change in that evidence retries it, with a fresh
 * resolution when its sender needs one. A delivery retried off a
 * pickup's turn — at a timer, or after a change — is acknowledged
 * through `acknowledge` once it is received or found terminal.
 */

import type { Secret } from "@estoc/did-peer";
import { DIDDocConversionError, type DIDDoc } from "@estoc/did-peer";
import { canonicalize, parseStrict, type VaultRuntime } from "@estoc/event-store/v3";
import { InvalidDidDocument, InvalidPublicKey, rawCidOfBytes, scanVault, type Did, type DidId, type DidUrl, type Keys, type KeyName, type MediationId, type VaultFold } from "@estoc/vault/v3";

import { didOf, secretsResolverFor, unpackMessage, type DIDResolver, type DidcommApi, type IMessage, type UnpackMetadata } from "../../protocol/didcomm.js";
import { envelopeHeader } from "../../protocol/envelope.js";
import { didcommDocumentOf, pinnedResolver } from "../evidence.js";
import type { Keyring } from "../keyring.js";
import { GLOBAL_TIMERS, LONGEST_TIMER_MS, type Timers } from "../outbox.js";
import type { Handle } from "../pickup.js";
import { serially } from "../procedure.js";
import { knownLongForms, resolve, type KnownLongForms, type Resolved, type ResolverOptions } from "../resolver.js";
import { note, type TraceData } from "../trace.js";
import { RESOLUTION_POLICY, ResolutionSequence, type ResolutionPolicy, type Retention } from "./accounting.js";
import { classifyRecipients, pairEvidence, sealingOf, senderProof, type AuthenticatedSender } from "./gate.js";

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
 * ends it; terminal; waiting for relationship evidence at its address
 * pair; or held for something of this runtime's that is not ready.
 */
export type ReceiptOutcome = { outcome: "received" } | { outcome: "terminal"; reason: string } | { outcome: "wait"; reason: string } | { outcome: "deferred"; reason: string };

export type Receipt = (authenticated: Authenticated) => Promise<ReceiptOutcome>;

/**
 * What a held delivery waits for: `local`, something of this runtime's
 * — the vault, a recipient's route or key check; `resolution`, its
 * sender's next resolution; `relationship`, evidence to select its
 * relationship; `history`, a document it names that no evidence holds.
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
  /** what a wait for relationship evidence at a pair is retried on a change of; `pairEvidence` by default */
  evidenceOf?: (fold: VaultFold, localDid: Did, peerDid: Did) => string;
  /** the most envelope bytes held for retries, all deliveries together */
  maxHeldBytes?: number;
  timers?: Timers;
  now?: () => number;
  log?: (line: string) => void;
}

export const MAX_HELD_BYTES = 16 * 1024 * 1024;

type Wait =
  | { kind: "local" | "resolution"; source: Source; reason: string }
  | { kind: "relationship"; source: Source; reason: string; localDid: Did; peerDid: Did; evidence: string; retry: boolean }
  | { kind: "history"; source: Source; reason: string; did: string; retry: boolean };

/** What the resolver was asked while an envelope opened: the sender's answer, and every other DID no evidence held. */
interface Asked {
  sender: { did: string; answer: Resolved } | null;
  missing: string[];
}

const WEB = /^did:web:/;
const utf8 = new TextEncoder();

export class Receiver {
  private readonly policy: ResolutionPolicy;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly evidenceOf: (fold: VaultFold, localDid: Did, peerDid: Did) => string;
  private readonly maxHeldBytes: number;
  private readonly waits = new Map<string, Wait>();
  private readonly sequences = new Map<string, ResolutionSequence>();
  private readonly held = new Map<string, Delivery>();
  private heldBytes = 0;
  private readonly wakes = new Map<string, unknown>();
  private closed = false;

  constructor(
    private readonly runtime: VaultRuntime,
    private readonly keys: Keys,
    private readonly ring: Keyring,
    private readonly options: ReceiverOptions
  ) {
    this.policy = { ...RESOLUTION_POLICY, ...options.policy };
    this.timers = options.timers ?? GLOBAL_TIMERS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.evidenceOf = options.evidenceOf ?? pairEvidence;
    this.maxHeldBytes = options.maxHeldBytes ?? MAX_HELD_BYTES;
  }

  /** One delivery through the gate, in turn with every other step for the same delivery. */
  async receive(delivery: Delivery): Promise<Received> {
    const key = deliveryKey(delivery);
    if (key === null) {
      const reason = "the envelope is not strict JSON";
      await this.diag(delivery, { outcome: "terminal", reason });
      return { outcome: "terminal", key, reason };
    }
    return serially(this, key, () => this.enter(key, delivery));
  }

  /** The pickup handle for one arrangement: a delivery received or terminal is taken, a held one left queued. */
  pickupHandle(mediationId: MediationId): Handle {
    return async (delivered) => {
      const source: Source = { kind: "pickup", mediationId, deliveryId: delivered.attachmentId };
      if ("unreadable" in delivered) {
        const key = deliveryKey({ packed: "", source }) as string;
        return serially(this, key, () => this.finish(key, { packed: "", source, parent: delivered.parent }, `the attachment does not read: ${delivered.unreadable}`)).then(() => "acked");
      }
      const received = await this.receive({ packed: delivered.packed, source, parent: delivered.parent });
      return received.outcome === "deferred" ? "skip" : "acked";
    };
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
      if (!(await this.changed(fold, wait))) continue;
      const received = await serially(this, key, () => (this.waits.get(key) === wait ? this.retry(key, wait) : Promise.resolve(null)));
      if (received !== null) results.push(received);
    }
    return results;
  }

  /** Whether what an evidence wait waits on is different in `fold`; a wait for anything else is not retried on evidence. */
  private async changed(fold: VaultFold, wait: Wait): Promise<boolean> {
    switch (wait.kind) {
      case "relationship":
        return this.evidenceOf(fold, wait.localDid, wait.peerDid) !== wait.evidence;
      case "history":
        return (await pinnedResolver(fold).resolve(wait.did)) !== null;
      default:
        return false;
    }
  }

  /** Something of this runtime's may be ready now: every delivery held for it is retried from its bytes. */
  async localStateChanged(): Promise<Received[]> {
    const results: Received[] = [];
    for (const [key, wait] of [...this.waits]) {
      if (wait.kind !== "local") continue;
      const received = await serially(this, key, () => (this.waits.get(key) === wait ? this.retry(key, wait) : Promise.resolve(null)));
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

  /** No retry after this: every timer cancelled. What is held is dropped; the mediator still has it. */
  close(): void {
    this.closed = true;
    for (const handle of this.wakes.values()) this.timers.clear(handle);
    this.wakes.clear();
  }

  private enter(key: string, delivery: Delivery): Promise<Received> {
    const wait = this.waits.get(key);
    if ((wait?.kind === "relationship" || wait?.kind === "history") && !wait.retry) {
      this.hold(key, delivery);
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
    const received = await this.attempt(key, delivery);
    if (received.outcome !== "deferred" && delivery.source.kind === "pickup" && this.options.acknowledge !== undefined) {
      try {
        await this.options.acknowledge(delivery.source);
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
      return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: `the vault is not read: ${messageOf(err)}` });
    }
    const header = envelopeHeader(delivery.packed);
    if (header.kind !== "authcrypt" && header.kind !== "anoncrypt") return this.finish(key, delivery, `not an envelope encrypted to its recipients (${header.kind})`);
    const recipients = classifyRecipients(fold, header.kids ?? []);
    if (recipients.verdict === "terminal") return this.finish(key, delivery, recipients.reason);
    if (recipients.verdict === "pending") return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: recipients.reason });
    await this.ring.reload(fold);
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
      [plaintext, metadata] = await unpackMessage(this.options.didcomm, delivery.packed, this.resolverFor(key, delivery.source, fold, sealing.skid, asked), secretsResolverFor(secrets), {});
    } catch (err) {
      await note(this.options.trace ?? null, { stream: "envelope", what: "error", data: { ...header, parent: delivery.parent, error: messageOf(err) } });
      return this.unopened(key, delivery, asked, err);
    }
    const resolution = asked.sender?.answer.outcome === "resolved" ? asked.sender.answer.resolution : null;
    const proof = senderProof(plaintext, metadata, sealing, resolution);
    this.sequences.delete(key);
    const rotation = metadata.from_prior ?? null;
    await note(this.options.trace ?? null, { stream: "envelope", what: "open", data: { ...header, parent: delivery.parent, type: plaintext.type, ...(rotation === null ? {} : { from_prior: { iss: rotation.iss, sub: rotation.sub } }) } });
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
      case "wait": {
        if (proof.sender === null) return this.defer(key, delivery, { kind: "local", source: delivery.source, reason: outcome.reason });
        const localDid = recipients.did;
        const peerDid = proof.sender.resolution.did;
        return this.defer(key, delivery, { kind: "relationship", source: delivery.source, reason: outcome.reason, localDid, peerDid, evidence: this.evidenceOf(fold, localDid, peerDid), retry: false });
      }
    }
  }

  /** An envelope that did not open: why, as far as what the resolver was asked tells. */
  private unopened(key: string, delivery: Delivery, asked: Asked, err: unknown): Promise<Received> {
    const sender = asked.sender;
    if (sender?.answer.outcome === "unavailable") {
      const now = this.now();
      const sequence = this.sequences.get(key);
      const wake = sequence?.unavailable(now) ?? null;
      if (sequence === undefined || wake === null) return this.finish(key, delivery, `${sender.did} is not resolved: ${sequence?.stopped(now) ?? "no sequence"}; the last answer: ${sender.answer.reason}`);
      this.schedule(key, wake);
      return this.defer(key, delivery, { kind: "resolution", source: delivery.source, reason: `${sender.did} is not resolved now: ${sender.answer.reason}` });
    }
    if (sender?.answer.outcome === "definitive") return this.finish(key, delivery, `${sender.did} does not resolve: ${sender.answer.reason}`);
    const [missing] = asked.missing;
    if (sender?.answer.outcome === "resolved" && missing !== undefined) {
      this.sequences.delete(key);
      return this.defer(key, delivery, { kind: "history", source: delivery.source, reason: `the envelope names ${missing}, whose document no evidence holds`, did: missing, retry: false });
    }
    return this.finish(key, delivery, `the envelope does not open: ${messageOf(err)}`);
  }

  /**
   * The resolver the envelope opens with. The first DID asked — the one
   * the header names as sealing it, when it names one — is the sender's,
   * resolved for this delivery: a `did:web` over the network, counted
   * before the call. Every other DID, a `from_prior` issuer's among
   * them, is answered only from what the vault already holds.
   */
  private resolverFor(key: string, source: Source, fold: VaultFold, skid: string | null, asked: Asked): DIDResolver {
    const senderDid = skid === null ? null : didOf(skid);
    const known = knownLongForms(fold);
    return {
      resolve: async (did: string): Promise<DIDDoc | null> => {
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
        const document = await pinnedResolver(fold, { current: sender?.answer.outcome === "resolved" ? [sender.answer.resolution] : [] }).resolve(did);
        if (document === null) asked.missing.push(did);
        return document;
      },
    };
  }

  private resolveSender(key: string, source: Source, did: string, known: KnownLongForms): Promise<Resolved> {
    if (WEB.test(did)) {
      let sequence = this.sequences.get(key);
      if (sequence === undefined) {
        sequence = new ResolutionSequence(this.policy, this.now(), this.options.retention?.(source) ?? {});
        this.sequences.set(key, sequence);
      }
      sequence.count();
    }
    return resolve(did, known, this.options);
  }

  private async defer(key: string, delivery: Delivery, wait: Wait): Promise<Received> {
    if (wait.kind !== "resolution") {
      this.sequences.get(key)?.suspend(this.now());
      this.cancel(key);
    }
    this.waits.set(key, wait);
    this.hold(key, delivery);
    await this.diag(delivery, { outcome: "deferred", wait: wait.kind, reason: wait.reason, attempts: this.sequences.get(key)?.attempts });
    return { outcome: "deferred", key, wait: wait.kind, reason: wait.reason };
  }

  /** A delivery that ends here: received when `reason` is null, terminal otherwise. Nothing of it is kept. */
  private async finish(key: string, delivery: Delivery, reason: string | null): Promise<Received> {
    this.waits.delete(key);
    this.sequences.delete(key);
    this.release(key);
    this.cancel(key);
    await this.diag(delivery, reason === null ? { outcome: "received" } : { outcome: "terminal", reason });
    return reason === null ? { outcome: "received", key } : { outcome: "terminal", key, reason };
  }

  private hold(key: string, delivery: Delivery): void {
    const others = this.heldBytes - (this.held.get(key)?.packed.length ?? 0);
    if (others + delivery.packed.length > this.maxHeldBytes) {
      this.release(key);
      return;
    }
    this.held.set(key, delivery);
    this.heldBytes = others + delivery.packed.length;
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
        serially(this, key, () => (this.waits.get(key) === wait ? this.retry(key, wait) : Promise.resolve(null))).catch((err: unknown) => this.log(`a held delivery was not retried: ${messageOf(err)}`));
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
  if (source.kind === "pickup") return JSON.stringify(["pickup", source.mediationId, source.deliveryId]);
  try {
    return JSON.stringify(["direct", rawCidOfBytes(canonicalize(parseStrict(utf8.encode(delivery.packed))))]);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
