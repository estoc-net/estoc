/**
 * Outbound: what a message of ours becomes on its way out (vault-events.md
 * §3, §6, §7.2), and the outbox it waits in. Composing — from which key
 * of ours, to which DID of theirs, vouched for by which DID they know us
 * by; recording — the `message.out`, body first, before anything touches
 * the wire; delivering — sealed to them, forwarded through their mediator
 * when they have one, POSTed, traced layer by layer. The outbox is a
 * reading of the fold and holds nothing of its own: every `message.out`
 * not yet `sent`, tried in order per contact, each try one
 * `delivery.attempted` (§3.1); one held is left alone unless named, and
 * one on a channel since frozen (§3.2) is not sent from it.
 *
 * Moved from the v1 agent — compose, attachFromPrior, ensurePairwise,
 * logOutbound, deliverToContact, drainOutbox, attemptDelivery, retry,
 * flush. What changed: which key we write from is the contact's
 * `keys` (a `contact.useKey`, §6), which DID they know us by is
 * `addressedAs` and the thread, all folds; and an attempt is an event
 * on the message's channel, not a line in a deliveries file.
 */

import type { DIDDoc } from "@estoc/did-peer";
import type { Cid, EventStore } from "@estoc/event-store";
import { drafts, notePeerResolved, record, recordMessage, sameChannel, type ChannelKey, type Contact, type Message, type MyKey, type VaultEvent, type VaultFold } from "@estoc/vault";
import { v7 as uuidv7 } from "uuid";

import { ENCRYPTED_MIME, endpointOf, plainMessage, secretsResolverFor, serviceUris, type DidcommApi, type IMessage } from "./protocol/didcomm.js";
import { FORWARD } from "./protocol/spec.js";
import { outboundPair, resolvedOf } from "./channel.js";
import type { SendOptions } from "./handler.js";
import type { PeerVault } from "./identity.js";
import type { Keyring, MyIdentity, Routed } from "./keyring.js";
import { fillBlocks, stripBlocks } from "./lift.js";
import { bounded, type MediatorLink } from "./link.js";
import { current, register, routedOf } from "./mediation.js";
import { attributedTo, didPlaceholder, messageRecord, nameOf, type MessageRecord, type PlainMessage } from "./records.js";
import type { TraceData } from "./trace.js";

export interface OutboundOptions {
  /** the DID-rotation header's signer: `FromPrior` */
  didcomm: DidcommApi;
  /** the DID we write to, and the mediator its service names: resolved before every compose and every delivery */
  resolveDid: (did: string) => Promise<DIDDoc | null>;
  /** how long one delivery may take, resolutions and seals included (default 15 s) */
  deliveryTimeoutMs?: number;
  /** the clock a mid is minted by, and a from_prior dated by */
  clock?: () => Date;
  log?: (line: string) => void;
  /**
   * The mint-lock's chain (see `fromKey`), handed in by a caller that
   * rebuilds composers across restarts: the lock is the identity's, not
   * one composer's, and two composers over one vault must share it.
   * Left out, the composer keeps one of its own.
   */
  choosing?: { chain: Promise<unknown> };
}

/** A message composed and not yet recorded: the plaintext, the channel it will go out on, the DID it is addressed to. */
export interface Composed {
  plain: IMessage;
  /** the key of ours it is from and the key of theirs it will be sealed to (§3) */
  pair: ChannelKey;
  /** the contact's current DID, which `plain.to` names */
  to: string;
}

const utf8 = new TextEncoder();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A message type as the log names it: the last three segments of its URI. */
function shortType(type: string): string {
  return type.split("/").slice(-3).join("/");
}

/**
 * Minted under this device's current mediation *and* its routing DID:
 * the mediation is this device's own (§5: a mediation binds one
 * device), so the mediator delivers what comes back here; the route is
 * the one the DID's service names now. A key under another device's
 * mediation is derived here after a merge, and is not written from
 * (§3.2): its mail is that device's.
 */
function underCurrent(key: MyKey | null, routed: Routed): key is MyKey & { minted: NonNullable<MyKey["minted"]> } {
  return key !== null && key.minted !== null && key.minted.mediation === routed.id && key.minted.routingDid === routed.routingDid;
}

export class Outbound {
  private readonly didcomm: DidcommApi;
  private readonly resolveDid: OutboundOptions["resolveDid"];
  private readonly resolver: { resolve: (did: string) => Promise<DIDDoc | null> };
  private readonly timeoutMs: number;
  private readonly clock: () => Date;
  private readonly log: (line: string) => void;
  /** the `fromKey` in progress (`OutboundOptions.choosing`): one choice at a time, so two first messages at once mint one key, not two */
  private readonly choosing: { chain: Promise<unknown> };

  constructor(
    private readonly opened: PeerVault,
    private readonly keyring: Keyring,
    /** the wire and its trace: sealing, the frame out, what came back */
    private readonly link: MediatorLink,
    options: OutboundOptions
  ) {
    this.didcomm = options.didcomm;
    this.resolveDid = options.resolveDid;
    this.resolver = { resolve: (did) => options.resolveDid(did) };
    this.timeoutMs = options.deliveryTimeoutMs ?? 15_000;
    this.clock = options.clock ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.choosing = options.choosing ?? { chain: Promise.resolve() };
  }

  private get fold(): VaultFold {
    return this.opened.fold;
  }

  private get events(): EventStore {
    return this.opened.vault.events;
  }

  // ---- composing ------------------------------------------------------------

  /**
   * One message to a contact: to their current DID, resolved now and
   * recorded as `peer.resolved` on the channel it will go out on (§3.1
   * — the edge that makes the channel theirs); from the key of ours
   * toward them, minted now when there is none (`fromKey`); naming their
   * invitation as `pthid` while we are still answering it; and carrying
   * `from_prior` while they know us by another DID (`vouch`). Needs a
   * granted mediation: a key is minted on its route. Nothing is
   * recorded of the message itself: `record` is the next step.
   */
  async compose(cid: string, type: string, body: Record<string, unknown>, options: SendOptions = {}): Promise<Composed> {
    const routed = routedOf(this.keyring.current());
    if (routed === null) {
      throw new Error("no mediation granted yet: nothing to write from");
    }
    // the representative (§6): a member's cid — held across a merge, or a deletion — locks, mints
    // and writes under the one contact it is part of, not under a cid the fold reads nothing from
    const rep = this.contact(cid).cid;
    const to = this.toDid(this.contact(rep));
    const doc = await this.resolveDid(to);
    if (doc === null) {
      throw new Error(`${didPlaceholder(to)} does not resolve`);
    }
    const from = await this.fromKey(rep, routed);
    const contact = this.contact(rep); // read again: a mint, or a send that took its turn first, is in the fold now
    const { pair } = outboundPair(from.key, doc);
    await notePeerResolved(this.events, this.fold, resolvedOf(pair, to, doc));
    const plain = plainMessage(type, from.identity.did, to, body);
    if (options.thid !== undefined) {
      plain.thid = options.thid;
    }
    const pthid = options.pthid ?? this.invitationAnswered(contact);
    if (pthid !== undefined) {
      plain.pthid = pthid;
    }
    if (options.attachments !== undefined) {
      plain.attachments = options.attachments as IMessage["attachments"];
    }
    const vouched = await this.vouch(contact, from);
    if (vouched !== null) {
      plain.from_prior = vouched;
    }
    return { plain, pair, to };
  }

  /**
   * The `message.out` (§3.1), body first (§4): the plaintext into the
   * blob store, then the skeleton — `roots` the blobs lifted out of it,
   * put by the caller before this. With roots named, the body is the
   * plaintext as stored (`lift.ts`): the block attachments whose bytes
   * `blobs/` holds keep their id and lose their `data`; the outbox puts
   * the bytes back for the wire. Nothing has touched the wire: what is
   * recorded waits in the outbox, and a delivery is the outbox's to try.
   */
  async record({ plain, pair }: Composed, roots: Cid[] = []): Promise<MessageRecord> {
    const mid = uuidv7({ msecs: this.clock().getTime() });
    const stored = roots.length === 0 ? plain : await stripBlocks(plain as PlainMessage, (cid) => this.opened.vault.blobs.has(cid));
    await recordMessage(this.opened.vault, this.fold, "out", utf8.encode(JSON.stringify(stored)), {
      ...pair,
      mid,
      wireId: plain.id,
      msgType: plain.type,
      ...(typeof plain.thid === "string" ? { thid: plain.thid } : {}),
      ...(typeof plain.pthid === "string" ? { pthid: plain.pthid } : {}),
      attachments: roots,
    });
    const found = await messageRecord(this.fold, this.opened.vault.blobs, mid);
    if (found === null) {
      throw new Error(`${mid} was recorded and is not in the fold`);
    }
    return found;
  }

  // ---- delivering -----------------------------------------------------------

  /**
   * One message on the wire, to `to` — the contact's DID now, which may
   * not be the one the plaintext names: a DID they moved to under the
   * same key. The record keeps the address it was written to; the copy
   * on the wire names where it went, since an envelope is sealed only
   * to a DID its plaintext addresses. Sealed from the DID the plaintext
   * is from to the first agreement key their document lists (§11) — the
   * document resolved once here, which the service is read off and the
   * key is sealed to, so that a did:web changing between two
   * resolutions cannot pair one version's key with the other's
   * endpoint; the mediator's document the same. When their service is a
   * DID — a mediator — a forward for them, sealed to no one, is what
   * goes on the wire, to the mediator's HTTP endpoint; when it is an
   * endpoint, the envelope goes straight there. Traced as the frame,
   * then the envelopes inside it, outermost first, the innermost naming
   * `mid`. Throws on anything short of a 2xx, and on a line cut before
   * one.
   */
  async deliver(plain: IMessage, to: string, mid: string): Promise<void> {
    // one budget from entry: the resolutions and seals before the POST ride
    // the same delivery queue, and must not hold it past the deadline either
    const signal = AbortSignal.timeout(this.timeoutMs);
    const from = plain.from;
    if (typeof from !== "string") {
      throw new Error("the plaintext names no DID of ours to seal from");
    }
    // the key it is sealed from must be held: derived now when its mint
    // landed after this ring loaded (composed under an earlier assembly)
    const name = this.fold.myKeys().find((key) => key.minted?.did === from)?.key;
    if (name !== undefined) {
      await this.keyring.holdMinted(name);
    }
    const doc = await bounded(signal, () => this.resolveDid(to));
    if (doc === null) {
      throw new Error(`${didPlaceholder(to)} does not resolve`);
    }
    const service = serviceUris(doc)[0];
    if (service === undefined) {
      throw new Error(`${didPlaceholder(to)} names no service endpoint`);
    }
    const documents = new Map<string, DIDDoc>([[to, doc]]);
    const addressed = plain.to?.includes(to) ? plain : ({ ...plain, to: [to] } as IMessage);
    const inner = await bounded(signal, () => this.link.seal(addressed, to, from, documents));
    let endpoint: string;
    let outer: { packed: string; seal: TraceData; forward: IMessage } | null = null;
    if (service.startsWith("did:")) {
      const routingDoc = await bounded(signal, () => this.resolveDid(service));
      const http = routingDoc === null ? null : endpointOf(routingDoc, "http");
      if (routingDoc === null || http === null) {
        throw new Error(`${didPlaceholder(to)}'s mediator has no HTTP endpoint`);
      }
      documents.set(service, routingDoc);
      const forward = {
        ...plainMessage(FORWARD, null, service, { next: to }),
        attachments: [{ id: crypto.randomUUID(), media_type: ENCRYPTED_MIME, data: { json: JSON.parse(inner.packed) as unknown } }],
      } as IMessage;
      const sealed = await bounded(signal, () => this.link.seal(forward, service, null, documents));
      outer = { packed: sealed.packed, seal: sealed.seal, forward };
      endpoint = http;
    } else if (service.startsWith("http")) {
      endpoint = service;
    } else {
      throw new Error(`unroutable service endpoint: ${service}`);
    }
    const packed = outer === null ? inner.packed : outer.packed;
    // the frame first, then the envelopes inside it, outermost first
    const out = await bounded(signal, () => this.link.traceOut("http", endpoint, packed, { type: plain.type }));
    const wrap = outer === null ? out : await bounded(signal, () => this.link.traceSeal(outer.seal, out, outer.forward));
    await bounded(signal, () => this.link.traceSeal({ ...inner.seal, mid }, wrap));
    const { ok, status, text, ms } = await bounded(signal, () => this.link.post(endpoint, packed, out, signal));
    // the reply's note loses alone: the answer is in hand, and a 2xx the far
    // side applied must not be retold as a failure because a local trace hung
    try {
      await bounded(signal, () => this.link.traceIn("http", text, { parent: out, status, ms }));
    } catch {
      this.log("trace not written: the deadline passed while noting the reply");
    }
    if (!ok) {
      throw new Error(`endpoint answered ${status}`);
    }
  }

  // ---- inside ---------------------------------------------------------------

  private contact(cid: string): Contact {
    const contact = this.fold.contact(cid);
    if (contact === null) {
      throw new Error(`no contact ${cid}`);
    }
    return contact;
  }

  /** The DID they are written to: the current one; the latest of several, said so — a conflict is shown, not solved here (§7.2). */
  private toDid(contact: Contact): string {
    const to = contact.currentDids.at(-1);
    if (to === undefined) {
      throw new Error(`${nameOf(contact)} has no DID to write to`);
    }
    if (contact.currentDids.length > 1) {
      this.log(`${nameOf(contact)} has ${contact.currentDids.length} current DIDs; writing to ${didPlaceholder(to)}`);
    }
    return to;
  }

  /**
   * The key of ours we write to this contact from: the latest live
   * `contact.useKey` under this device's current mediation and route
   * (`underCurrent`) that the ring holds — a key minted toward them, or
   * the invitation they took (§7.4) — else one minted now
   * (`Keyring.mintToward`: `did.minted` + `contact.useKey`). A key on
   * another route, or under another device's mediation, is no address
   * of this device's (§3.2) and is passed over; one the ring has not
   * derived yet is derived and held now (`holdMinted` — a mint that
   * landed after this ring loaded, under an earlier assembly); one the
   * seed does not derive is not ours to write from. One choice at a time, across every
   * contact — not per contact: the representative a cid resolves to can
   * change under a merge while a compose waits, and a lock keyed on it
   * can split one contact across two chains. Choosing is fold reads and
   * at most one mint, nothing on the wire, so the queue is short; the
   * second chooser finds the first's mint in the fold rather than
   * minting its own, whenever the two turn out to be one contact.
   */
  private fromKey(cid: string, routed: Routed): Promise<MyIdentity> {
    const run = this.choosing.chain.then(() => this.chooseKey(cid, routed));
    this.choosing.chain = run.catch(() => undefined);
    return run;
  }

  private async chooseKey(cid: string, routed: Routed): Promise<MyIdentity> {
    const contact = this.contact(cid);
    for (const use of [...contact.keys].reverse()) {
      if (!underCurrent(this.fold.myKey(use.key), routed)) {
        continue;
      }
      const held = await this.keyring.holdMinted(use.key);
      if (held !== null) {
        return held;
      }
    }
    // `contact.cid`, not `cid`: under a merge that landed while we waited, the representative of record
    const minted = await this.keyring.mintToward(contact.cid, routed);
    this.log(`minted a DID of our own toward ${nameOf(contact)}`);
    return minted;
  }

  /**
   * The invitation of theirs we accepted, named as `pthid` by our first
   * messages — up to and including the introduction, as out-of-band
   * asks; once a profile of ours has gone out to them, no more.
   */
  private invitationAnswered(contact: Contact): string | undefined {
    if (contact.profileSharedAt !== null) {
      return undefined;
    }
    return contact.attached.find((attach) => attach.because === "accepted")?.oobId ?? undefined;
  }

  /**
   * `from_prior`: the DID they know us by, signing over the one we write
   * from, while the two differ. They know us by the key they last wrote
   * to (`addressedAs`, §7.2); before they ever wrote, by the one we last
   * wrote from that is not this one; before either, by our public DID —
   * the card they most likely took our address from — unless they gave
   * us theirs (`accepted`): then neither knew the other's public DID,
   * there is no prior, and no reason to hand them one. Silence is not
   * consent: the header rides along until a reply reaches the new key.
   * A prior this seed does not hold cannot sign, and the message goes
   * without, said so.
   */
  private async vouch(contact: Contact, from: MyIdentity): Promise<string | null> {
    const prior = this.priorOf(contact, from);
    if (prior === null || prior === from.identity.did) {
      return null;
    }
    const name = this.keyring.keyOfDid(prior);
    const held = name === null ? null : this.keyring.identityOf(name);
    if (held === null) {
      this.log(`${nameOf(contact)} knows us by a DID this seed does not hold; sending without from_prior`);
      return null;
    }
    const [jwt] = await new this.didcomm.FromPrior({ iss: prior, sub: from.identity.did, iat: Math.floor(this.clock().getTime() / 1000) }).pack(
      `${prior}#key-1`,
      this.resolver,
      secretsResolverFor(held.secrets)
    );
    return jwt;
  }

  private priorOf(contact: Contact, from: MyIdentity): string | null {
    const addressed = contact.addressedAs === null ? null : this.didOfKey(contact.addressedAs);
    if (addressed !== null) {
      return addressed;
    }
    const wroteFrom = contact.thread.filter((message) => message.direction === "out" && message.pair.myKey !== null && message.pair.myKey !== from.key).at(-1);
    if (wroteFrom !== undefined) {
      const did = this.didOfKey(wroteFrom.pair.myKey as string);
      if (did !== null) {
        return did;
      }
    }
    if (contact.attached.some((attach) => attach.because === "accepted")) {
      return null;
    }
    return this.keyring.pub()?.identity.did ?? null;
  }

  /** The DID a key of ours was minted as; null for a name the fold has no mint for. */
  private didOfKey(name: string): string | null {
    return this.fold.myKey(name)?.minted?.did ?? null;
  }
}

// ---- the outbox --------------------------------------------------------------

export interface OutboxOptions {
  log?: (line: string) => void;
}

/** One try's event: what the fold folds into a message's `Delivery`. */
export type Attempted = VaultEvent<"delivery.attempted">;

/**
 * The outbox: every `message.out` the fold does not show `sent`, and the
 * passes over it. A pass tries each waiting message once, oldest first,
 * narrowed to one contact or one message when asked; a failure for a
 * contact stops the pass for that contact, so their messages never
 * overtake one another, and other contacts go on. Held messages (§3.1,
 * this device's `delivery.held`) are skipped unless named by `mid` —
 * that is what a retry by hand is. Passes are serialised, so a start, a
 * reconnect and a send cannot try one message at the same time. A
 * message on a channel since frozen (§3.2) is tried and fails, saying
 * why: nothing is sent from a key that is not this device's current
 * address, or to a key that is not theirs any more; writing again from
 * where both sides are now is the sender's to do.
 */
export class Outbox {
  private readonly log: (line: string) => void;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opened: PeerVault,
    /** the line to our mediator: the key we write from is registered over it, first */
    private readonly link: MediatorLink,
    private readonly outbound: Outbound,
    options: OutboxOptions = {}
  ) {
    this.log = options.log ?? (() => undefined);
  }

  private get fold(): VaultFold {
    return this.opened.fold;
  }

  private get events(): EventStore {
    return this.opened.vault.events;
  }

  /** Every `message.out` not sent, held ones included, in mid order. */
  waiting(): Message[] {
    return this.fold
      .messages()
      .filter((message) => message.direction === "out" && message.delivery !== null && message.delivery.status !== "sent")
      .sort((a, b) => (a.mid < b.mid ? -1 : a.mid > b.mid ? 1 : 0));
  }

  /** One pass, after the one before it: the tries it made, as their events. */
  drain(only: { cid?: string; mid?: string } = {}): Promise<Attempted[]> {
    const run = this.chain.then(() => this.pass(only));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Try one waiting message again now, by hand — a held one too.
   * Resolves to the try's event; throws when it is not waiting, or when
   * nothing can go out yet (no mediation granted).
   */
  async retry(mid: string): Promise<Attempted> {
    if (!this.waiting().some((message) => message.mid === mid)) {
      throw new Error("that message is not waiting to be sent");
    }
    if (!this.routed()) {
      throw new Error("no mediation granted yet: nothing to write from");
    }
    const [event] = await this.drain({ mid });
    if (event === undefined) {
      throw new Error("that message is not waiting to be sent");
    }
    return event;
  }

  /**
   * Try everything waiting now — what an application calls when it
   * learns the network is back before the socket does. Held stays held.
   * Nothing waiting, or nothing to write from yet: nothing done.
   */
  async flush(): Promise<Attempted[]> {
    if (!this.routed() || this.waiting().length === 0) {
      return [];
    }
    return this.drain();
  }

  // ---- inside ---------------------------------------------------------------

  private routed(): boolean {
    return routedOf(current(this.fold, this.opened.vault.self)) !== null;
  }

  private async pass(only: { cid?: string; mid?: string }): Promise<Attempted[]> {
    const attempted: Attempted[] = [];
    const stalled = new Set<string>();
    for (const message of this.waiting()) {
      if (only.mid !== undefined && message.mid !== only.mid) {
        continue;
      }
      if (only.mid === undefined && message.delivery?.status === "held") {
        continue;
      }
      const attribution = this.fold.attribution(message.pair);
      if (attribution.kind === "deleted") {
        continue; // written to a contact since deleted (§9): nobody's to send
      }
      const cid = attributedTo(attribution);
      if (only.cid !== undefined && cid !== only.cid) {
        continue;
      }
      if (cid !== null && stalled.has(cid)) {
        continue;
      }
      const event = await this.attempt(message, cid);
      attempted.push(event);
      if (event.data.outcome !== "sent" && cid !== null) {
        stalled.add(cid);
      }
    }
    return attempted;
  }

  /**
   * One try at a waiting message: on the channel it was written on,
   * which must still be one the contact is written to (`frozen`); from
   * the key it was written from, the mediator told of it first when it
   * has not been (`register`), so that what comes back finds us; to the
   * contact's DID now; sealed and POSTed (`Outbound.deliver`). Whatever
   * happens is one `delivery.attempted` on the message's channel
   * (§3.1): `sent`, and it is out of the outbox; `failed`, with why, and
   * it waits for the next pass. A message whose body, or whose lifted
   * blocks, were erased since it was written (§8) fails saying so: what
   * the record no longer holds is not sent. Nothing here throws but the
   * log refusing the event.
   */
  private async attempt(message: Message, cid: string | null): Promise<Attempted> {
    const attempt = (message.delivery?.attempts.length ?? 0) + 1;
    let outcome: "sent" | "failed" = "sent";
    let error: string | undefined;
    try {
      const routed = routedOf(current(this.fold, this.opened.vault.self));
      if (routed === null) {
        throw new Error("no mediation granted yet: nothing to write from");
      }
      if (cid === null) {
        throw new Error("no contact for the channel it was written on");
      }
      const contact = this.fold.contact(cid);
      if (contact === null) {
        throw new Error(`no contact ${cid}`);
      }
      const frozen = this.frozen(contact, message.pair, routed);
      if (frozen !== null) {
        throw new Error(frozen);
      }
      const found = await messageRecord(this.fold, this.opened.vault.blobs, message.mid);
      if (found === null || found.msg === null) {
        throw new Error(`its plaintext is ${found?.body ?? "gone"}`);
      }
      // what it carries, erased since (§8.2): as the body, asked before the blocks are
      const erased = found.skeleton.attachments.find((root) => found.erased.includes(root));
      if (erased !== undefined) {
        throw new Error(`what it carries is erased (${erased})`);
      }
      // the wire form (§4, `lift.ts`): the blocks the body names by id, back from `blobs/`
      const plain = await fillBlocks(found.msg, this.opened.vault.blobs);
      await this.ensureRegistered(message.pair.myKey as string);
      const to = contact.currentDids.at(-1);
      if (to === undefined) {
        throw new Error(`${nameOf(contact)} has no DID to write to`);
      }
      await this.outbound.deliver(plain as IMessage, to, message.mid);
    } catch (err) {
      outcome = "failed";
      error = messageOf(err);
      this.log(`could not deliver ${shortType(message.skeleton.msgType)} (try ${attempt}): ${error}`);
    }
    const event = await record(this.events, this.fold, drafts.deliveryAttempted({ ...message.pair, mid: message.mid, attempt, outcome, ...(error === undefined ? {} : { error }) }));
    return event as Attempted;
  }

  /**
   * Why nothing is sent on this channel (§3.2), or null while it is one
   * the contact is written to: the key of ours is retired, or under a
   * mediation that is not this device's current one (another device's,
   * or one since left); the key of theirs is not in their current
   * document; or the channel is claimed by more than one contact and is
   * no one's to write from until merged (§7.1). The contact's `writeTo`
   * is the fold's word on the last two.
   */
  private frozen(contact: Contact, pair: ChannelKey, routed: Routed): string | null {
    const key = pair.myKey === null ? null : this.fold.myKey(pair.myKey);
    if (key === null || key.minted === null) {
      return "written from no key of ours";
    }
    if (key.retired !== null) {
      return `written from a key since retired (${key.retired.because})`;
    }
    if (!underCurrent(key, routed)) {
      return "written from a key that is not under this device's mediation";
    }
    if (contact.writeTo.some((entry) => sameChannel(entry, pair))) {
      return null;
    }
    if (contact.channels.some((entry) => sameChannel(entry, pair))) {
      return "written to a key that is not in their document any more";
    }
    return "written on a channel that is not this contact's alone";
  }

  /**
   * The mediator told of the key we write from (§5), when it has not
   * been yet: what comes back rides that mapping. The key is this
   * device's own by now (`frozen` let it through), so `register` takes
   * it; recorded once, it is not asked about again.
   */
  private async ensureRegistered(name: string): Promise<void> {
    if (this.fold.myKey(name)?.registered.includes(this.opened.vault.self) ?? false) {
      return;
    }
    await register(this.link, this.opened, [name]);
  }
}
