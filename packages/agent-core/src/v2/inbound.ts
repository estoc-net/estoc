/**
 * Inbound policy: one opened envelope, the events it leaves and the
 * answer it gets (vault-events.md §3, §6, §7). In order: the channel it
 * proves, read off the envelope and the documents it was opened with;
 * the same wire id from the same key again, dropped; the observations a
 * device writes on first sight (`channel.firstSeen`, `peer.resolved`);
 * the `from_prior` a sender vouched with, as `peer.rotated`; an
 * invitation of ours taken, when the key is one; the contact the channel
 * belongs to, by attribution — a stranger adopted, a second taker of an
 * invitation turned away; an object-share's blocks kept; the message
 * itself, body first; and the answer: the specification's own types
 * here, the rest to the handler for the type, with the contact.
 *
 * The record comes last on purpose. The wire id seen is what makes a
 * redelivery a duplicate, and it is read from the record; so every event
 * a message gives rise to is in the log before the record is, and a
 * step that fails — the disk, a crash — leaves an envelope the mediator
 * still holds and a log the redelivery finishes: each step before the
 * record finds its own work done and does it once — and the record takes
 * the mid an earlier attempt's `peer.rotated` named, so the evidence
 * points at the message. What follows the record, the answer, is not
 * retried: a handler's reply to a message recorded just before a crash
 * is lost, as it was in v1.
 *
 * Every decision is the fold's to explain afterwards: nothing is kept
 * outside the log but the wire ids seen, and those are loaded from it.
 * What an envelope becomes is final once it is handed back — recorded,
 * a duplicate, or ignored, the pickup may acknowledge it; what throws is
 * left for a later pickup. Moved from the v1 agent — processDelivery's
 * inner loop, claimInvitation, applyRotation, ensureContact,
 * handleSpecMessage — with one change under all of it: a contact is a
 * component of events, not a record saved (§6), so every step here
 * appends and asks the fold.
 */

import type { DIDDoc } from "@estoc/did-peer";
import type { Cid, EventStore } from "@estoc/event-store";
import {
  drafts,
  isMediationKey,
  noteFirstSeen,
  notePeerResolved,
  record,
  recordAll,
  recordMessage,
  type AttachCause,
  type Attribution,
  type Channel,
  type ChannelKey,
  type InboundSkeleton,
  type VaultFold,
} from "@estoc/vault/v2";
import { v7 as uuidv7 } from "uuid";

import type { IMessage } from "../protocol/didcomm.js";
import { OBJECT_SHARE } from "../protocol/object-share.js";
import { TRUST_PING, TRUST_PING_RESPONSE, isSpecType } from "../protocol/spec.js";
import { inboundPair, resolvedOf, signerOf, type KeyOfDid, type Proved } from "./channel.js";
import type { HandlerContext, InboundRecord, ProtocolHandler } from "./handler.js";
import { keepShare } from "./handlers/object-share.js";
import type { PeerVault } from "./identity.js";
import type { Opened } from "./link.js";
import { contactRecord, didPlaceholder, messageRecord, type ContactRecord, type MessageRecord, type PlainMessage } from "./records.js";

export interface InboundOptions {
  /** the sender's document, and a signer's, which the channel is read from; null for a DID that does not resolve */
  resolveDid: (did: string) => Promise<DIDDoc | null>;
  /** the keyring's: which key of ours an envelope was opened with */
  keyOfDid: KeyOfDid;
  /** the handlers, built-in and the application's, by the types they speak; a later one for a type replaces an earlier */
  handlers?: ProtocolHandler[];
  /** a stranger's first message makes them a contact (default true); off, they stay unattributed until the person accepts them */
  adoptStrangers?: boolean;
  /** the clock a mid, and a cid, is minted by */
  clock?: () => Date;
}

/** What became of an opened envelope: final either way, so the pickup may acknowledge it. */
export type Handled =
  /** a plaintext: it proves no one, opens no channel, and leaves nothing */
  | { outcome: "ignored" }
  /** the same wire id from the same key again: recorded already */
  | { outcome: "duplicate" }
  /** recorded, and homed to `contact` when the channel has one */
  | { outcome: "recorded"; record: MessageRecord; contact: ContactRecord | null };

const utf8 = new TextEncoder();

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The dedup key: the wire id, from this key of theirs — an anonymous envelope's, from no one. */
function seenKey(peerKey: string | null, wireId: string): string {
  return `${peerKey ?? ""}\n${wireId}`;
}

/** The cid an attribution names: one, or the first of several; null for none, and for deleted — the caller's to tell apart first. */
function pick(attribution: Attribution): string | null {
  switch (attribution.kind) {
    case "one":
      return attribution.cid;
    case "several":
      return attribution.cids[0] as string;
    default:
      return null;
  }
}

/** The skeleton (§3.1) of a message that proved `proved`: `did` with a peer key, never without. */
function skeletonOf(proved: Proved, sender: string | null, msg: IMessage, mid: string, attachments: Cid[]): InboundSkeleton {
  const base = {
    myKey: proved.pair.myKey,
    mid,
    wireId: msg.id,
    msgType: msg.type,
    ...(typeof msg.thid === "string" ? { thid: msg.thid } : {}),
    ...(typeof msg.pthid === "string" ? { pthid: msg.pthid } : {}),
    attachments,
    ...(proved.signedBy === undefined ? {} : { signedBy: proved.signedBy }),
  };
  return proved.pair.peerKey === null ? { ...base, peerKey: null } : { ...base, peerKey: proved.pair.peerKey, did: sender as string };
}

export class Inbound {
  private readonly resolveDid: InboundOptions["resolveDid"];
  private readonly keyOfDid: KeyOfDid;
  private readonly handlers = new Map<string, ProtocolHandler>();
  private readonly adoptStrangers: boolean;
  private readonly clock: () => Date;
  /** every inbound wire id the fold holds, and the ones recorded since */
  private readonly seen = new Set<string>();

  constructor(
    private readonly opened: PeerVault,
    /** the agent's face to a handler: its `reply` answers a ping, its `log` is the log */
    private readonly ctx: HandlerContext,
    options: InboundOptions
  ) {
    this.resolveDid = options.resolveDid;
    this.keyOfDid = options.keyOfDid;
    for (const handler of options.handlers ?? []) {
      for (const type of handler.types) {
        this.handlers.set(type, handler);
      }
    }
    this.adoptStrangers = options.adoptStrangers ?? true;
    this.clock = options.clock ?? (() => new Date());
    for (const message of opened.fold.messages()) {
      if (message.direction === "in") {
        this.seen.add(seenKey(message.pair.peerKey, message.skeleton.wireId));
      }
    }
  }

  private get fold(): VaultFold {
    return this.opened.fold;
  }

  private get events(): EventStore {
    return this.opened.vault.events;
  }

  private log(line: string): void {
    this.ctx.log(line);
  }

  /** One opened envelope, through every step; throws when a step fails — a document that does not resolve now, a disk that will not take the body. */
  async handle(opened: Opened): Promise<Handled> {
    const { msg, metadata, sender, recipient, documents } = opened;
    // 1. the channel it proves (§3): the keys didcomm verified against, and the key of ours it found a secret for
    const senderDoc = await this.document(sender, documents);
    const signer = signerOf(metadata);
    const signerDoc = signer === null || signer === sender ? null : await this.document(signer, documents);
    const proved = inboundPair(metadata, senderDoc, (did) => (did === recipient ? this.keyOfDid(did) : null), signerDoc);
    if (proved === null) {
      this.log(`a plaintext ${msg.type} reached us as mail; it proves no one and is not kept`);
      return { outcome: "ignored" };
    }
    const { pair } = proved;
    // 2. seen before: recorded, so everything before the record was done too
    const key = seenKey(pair.peerKey, msg.id);
    if (this.seen.has(key)) {
      this.log(`${msg.type} ${msg.id} arrived again; recorded already`);
      return { outcome: "duplicate" };
    }
    // 3. what a device writes on sight (§3.1)
    await noteFirstSeen(this.events, this.fold, {
      ...pair,
      kind: proved.kind,
      ...(proved.peerPublicKey === undefined ? {} : { peerPublicKey: proved.peerPublicKey }),
      ...(sender === null ? {} : { firstDid: sender }),
    });
    if (sender !== null && senderDoc !== null) {
      await notePeerResolved(this.events, this.fold, resolvedOf(pair, sender, senderDoc));
    }
    // 4. the rotation it vouched for (§3.1 `peer.rotated`), before anything asks who the channel belongs to
    const mid = await this.noteRotation(opened, pair, this.mint());
    // 5. an invitation of ours (§7.4)
    const refusal = await this.takeInvitation(pair, sender);
    // 6. whose it is (§7.1)
    const homed = await this.home(pair, sender, msg.type, refusal);
    // 7. what the message carries, lifted out (§4)
    const attachments = msg.type === OBJECT_SHARE ? await keepShare(msg as PlainMessage, this.opened.vault.blobs, (line) => this.log(line)) : [];
    // 8. the message, body first (§4): the last event, and the one a redelivery is told apart by
    await recordMessage(this.opened.vault, this.fold, "in", utf8.encode(JSON.stringify(msg)), skeletonOf(proved, sender, msg, mid, attachments));
    this.seen.add(key);
    const found = await messageRecord(this.fold, this.opened.vault.blobs, mid);
    if (found === null) {
      throw new Error(`${mid} was recorded and is not in the fold`);
    }
    const contact = homed === null ? null : this.contactOf(homed.cid);
    // 9. the answer
    await this.answer(found, contact, sender);
    return { outcome: "recorded", record: found, contact };
  }

  /**
   * The document of a DID the envelope named: the one didcomm opened it
   * with, when it is among `documents`; else resolved now — and a DID
   * that does not resolve now is thrown on, a hiccup and not a verdict,
   * since didcomm resolved it to open the envelope.
   */
  private async document(did: string | null, documents: ReadonlyMap<string, DIDDoc>): Promise<DIDDoc | null> {
    if (did === null) {
      return null;
    }
    const doc = documents.get(did) ?? (await this.resolveDid(did));
    if (doc === null) {
      throw new Error(`${did} does not resolve now`);
    }
    return doc;
  }

  /**
   * Mail to a key published as a one-use invitation (§7.4). Open, and
   * from someone: taken — attached to the contact the peer key already
   * belongs to, when it does (they wrote to us by another key of ours
   * before), else to a contact created for them; `because: invitation`,
   * with the `oobId` their first messages name as `pthid`. Taken by
   * another key, or withdrawn (the key retired): nothing is attributed
   * here, and the reason is handed to `home`, which says it when nothing
   * else — a rotation just recorded, an attachment made elsewhere — homes
   * the channel. Anonymous mail takes nothing. A key that is no
   * invitation is nothing to this step. Done once: a redelivery finds
   * the invitation taken, and the channel attributed.
   */
  private async takeInvitation(pair: ChannelKey, sender: string | null): Promise<string | null> {
    if (pair.myKey === null) {
      return null;
    }
    const invitation = this.fold.invitations().find((entry) => entry.key === pair.myKey);
    if (invitation === undefined) {
      return null;
    }
    const key = this.fold.myKey(pair.myKey);
    if (key !== null && key.retired !== null) {
      return "someone wrote to an invitation since withdrawn; turned away";
    }
    if (!invitation.open) {
      return "someone else wrote to an invitation already taken; turned away";
    }
    if (sender === null) {
      return null;
    }
    const known = pick(this.fold.attribution(pair));
    if (known === null) {
      await this.adopt(pair, "invitation", invitation.oobId);
      this.log("someone took an invitation of ours; they have a thread now");
    } else {
      await record(this.events, this.fold, drafts.contactAttached({ ...pair, cid: known, because: "invitation", ...(invitation.oobId === null ? {} : { oobId: invitation.oobId }) }));
      this.log(`${this.contactOf(known).name} took an invitation of ours; that key is ours toward them now`);
    }
    return null;
  }

  /**
   * A `from_prior` didcomm-rust verified — signed by `iss`, naming `sub`
   * — is a rotation only when the envelope is `sub`'s own: a JWT is
   * public once sent, and anyone could replay it under their own key,
   * or anonymously (didcomm-rust refuses a plaintext whose `from` is
   * not the JWT's `sub`; the envelope's proven sender closes the gap
   * between the plaintext's claim and the key that sealed it). Recorded
   * on the channel `iss` was last resolved on — the old pair (§3.1) —
   * else on this one, when `iss` was never seen: a stranger vouching
   * with a DID they used elsewhere. Once: a later message still carrying
   * it, or this one redelivered, finds the two DIDs joined already.
   * Returns the mid the message is recorded under — `minted`, or the one
   * a rotation names that no message carries yet: an earlier attempt's,
   * cut off before its record, whose evidence this record is.
   */
  private async noteRotation(opened: Opened, pair: ChannelKey, minted: string): Promise<string> {
    const { sender, fromPrior } = opened;
    if (fromPrior === null || sender === null) {
      return minted;
    }
    if (fromPrior.sub !== sender) {
      this.log(`from_prior names ${didPlaceholder(fromPrior.sub)} but the envelope is from someone else; ignoring the rotation`);
      return minted;
    }
    if (this.fold.channel(pair)?.dids.includes(fromPrior.iss) ?? false) {
      return (await this.promisedMid(fromPrior.iss, sender)) ?? minted;
    }
    const old = this.channelOf(fromPrior.iss)?.pair ?? pair;
    await record(this.events, this.fold, drafts.peerRotated({ ...old, from: fromPrior.iss, to: sender, fromPrior: fromPrior.jwt, mid: minted }));
    this.log(`${didPlaceholder(fromPrior.iss)} moved to ${didPlaceholder(sender)}, vouched for by the old DID`);
    return minted;
  }

  /** The mid a `peer.rotated` from `from` to `to` names while no message carries it: what a record cut off before landing was to be. */
  private async promisedMid(from: string, to: string): Promise<string | null> {
    for await (const event of this.events.scan({ type: "peer.rotated", data: { from, to } })) {
      const named = event.data["mid"];
      if (typeof named === "string" && this.fold.message(named) === null) {
        return named;
      }
    }
    return null;
  }

  /** The channel `did` was last resolved on (§3.1 `peer.resolved`): where its key was seen; null when never. */
  private channelOf(did: string): Channel | null {
    let found: { channel: Channel; at: string } | null = null;
    for (const channel of this.fold.channels()) {
      const entry = channel.resolved.find((resolved) => resolved.did === did);
      if (entry !== undefined && (found === null || entry.at > found.at)) {
        found = { channel, at: entry.at };
      }
    }
    return found?.channel ?? null;
  }

  /**
   * The contact the channel belongs to (§7.1). One: theirs. Several:
   * shown under the first until merged, said so. Deleted: nobody's,
   * hidden. None: a stranger — adopted when the option says so
   * (`contact.created` + `contact.attached { because: manual }`) and
   * they wrote, not pinged: not anonymous, not turned away from an
   * invitation, not sealed to a mediation key (no contact's channel is
   * under one, §3), not a type the specification defines (pinging is
   * not writing). Once: a redelivery finds the channel attributed.
   */
  private async home(pair: ChannelKey, sender: string | null, type: string, refusal: string | null): Promise<ContactRecord | null> {
    const attribution = this.fold.attribution(pair);
    if (attribution.kind === "deleted") {
      this.log(`a ${type} from a contact since deleted; recorded, attributed to nobody`);
      return null;
    }
    const known = pick(attribution);
    if (known !== null) {
      if (attribution.kind === "several") {
        this.log(`${attribution.cids.length} contacts claim one channel; shown under ${this.contactOf(known).name} until merged`);
      }
      return this.contactOf(known);
    }
    if (sender === null) {
      this.log(`recorded an anonymous ${type}; it is attributed to nobody`);
      return null;
    }
    if (refusal !== null) {
      this.log(refusal);
      return null;
    }
    if (isMediationKey(pair.myKey)) {
      this.log(`a ${type} sealed to a mediation key of ours; recorded, attributed to nobody`);
      return null;
    }
    if (isSpecType(type)) {
      return null;
    }
    if (!this.adoptStrangers) {
      this.log(`a ${type} from a stranger; recorded, attributed to nobody until accepted`);
      return null;
    }
    const cid = await this.adopt(pair, "manual", null);
    this.log("a stranger wrote to us; they have a thread now");
    return this.contactOf(cid);
  }

  /** A contact for a channel: `contact.created` and `contact.attached` as one write, so that nothing failing between the two leaves a contact with nothing on it. */
  private async adopt(pair: ChannelKey, because: AttachCause, oobId: string | null): Promise<string> {
    const cid = this.mint();
    await recordAll(this.events, this.fold, [drafts.contactCreated({ cid }), drafts.contactAttached({ ...pair, cid, because, ...(oobId === null ? {} : { oobId }) })]);
    return cid;
  }

  /** A mid, or a cid: uuidv7 by the clock. */
  private mint(): string {
    return uuidv7({ msecs: this.clock().getTime() });
  }

  private contactOf(cid: string): ContactRecord {
    const contact = this.fold.contact(cid);
    if (contact === null) {
      throw new Error(`no contact ${cid}`);
    }
    return contactRecord(contact);
  }

  /**
   * The specification's own types are answered here and never handed
   * on: trust-ping when asked and from a contact — a stranger's ping
   * names nobody worth confirming our existence to, and pinging is not
   * writing, so it makes no contact either; a ping-response, an
   * invitation or a forward that reached us as mail are facts with
   * nothing to do. Everything else goes to the handler for its type,
   * with the contact — none, and there is nobody to answer. A handler
   * that throws is logged; the message stays handled.
   */
  private async answer(found: MessageRecord, contact: ContactRecord | null, sender: string | null): Promise<void> {
    if (found.msg === null) {
      this.log(`${found.skeleton.msgType} ${found.mid} recorded, but its plaintext does not read back as a message; not handled`);
      return;
    }
    const inbound: InboundRecord = { ...found, direction: "in", msg: found.msg };
    if (isSpecType(inbound.msg.type)) {
      await this.answerSpec(inbound, contact, sender);
      return;
    }
    if (contact === null) {
      return;
    }
    const handler = this.handlers.get(inbound.msg.type);
    if (handler === undefined) {
      this.log(`a ${inbound.msg.type} from ${contact.name}; recorded, no handler for it`);
      return;
    }
    if (handler.onInbound === undefined) {
      return;
    }
    try {
      await handler.onInbound(inbound, contact, this.ctx);
    } catch (err) {
      this.log(`handling a ${inbound.msg.type} from ${contact.name} failed: ${messageOf(err)}`);
    }
  }

  private async answerSpec(inbound: InboundRecord, contact: ContactRecord | null, sender: string | null): Promise<void> {
    const { msg } = inbound;
    if (msg.type !== TRUST_PING) {
      return;
    }
    if (contact === null) {
      // anonymous: `home` said so already
      if (sender !== null) {
        this.log("pinged by someone we do not know; ignoring");
      }
      return;
    }
    this.log(`${contact.name} pinged us`);
    if ((msg.body as { response_requested?: unknown }).response_requested !== true) {
      return;
    }
    try {
      await this.ctx.reply(contact, TRUST_PING_RESPONSE, {}, { thid: msg.id });
    } catch (err) {
      this.log(`could not answer ${contact.name}'s ping: ${messageOf(err)}`);
    }
  }
}
