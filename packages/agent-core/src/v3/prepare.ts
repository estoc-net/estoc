/**
 * Preparing turns a queued intent into the one exact envelope its
 * submission will carry. The intent chose the relationship; preparing
 * chooses nothing about it, only reads its current ends: the sender is
 * the current local end, under its long form and with the proof of the
 * transition that added it until the peer's input has confirmed it; the
 * recipient is the current peer end, at a key its pinned document
 * authorizes. What the network has to say is asked before the lock;
 * everything the answer changes is decided under it, over the fold read
 * again, and only once the fold still asks the question the answer is
 * to — receipt goes on meanwhile and can bind the pair, or move its
 * peer end by a verified continuation, in which case the answer is
 * dropped and the question asked again. The trace is written after the
 * lock and is never a reason to stop: the package is what was made.
 */

import { v7 as uuidv7 } from "uuid";

import { isPeerDID4 } from "@estoc/did-peer";
import { DamagedObject, ObjectTooLarge, canonicalize, isJsonObject, parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import {
  decodePublicKey,
  intentOfOutbound,
  objectReader,
  plaintextHash,
  rawCidOfBytes,
  readStoredDocument,
  readVaultEvent,
  scanVault,
  splitDidUrl,
  vaultDraft,
  wirePlaintext,
  type Cid,
  type Did,
  type DidKeys,
  type DidUrl,
  type EventReference,
  type KeyName,
  type Keys,
  type LocalNode,
  type MessageId,
  type MessageOut,
  type Outbound,
  type PackageId,
  type PeerNode,
  type PublicKey,
  type Relationship,
  type RelationshipId,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { secretsResolverFor, type DidcommApi, type IMessage } from "../protocol/didcomm.js";
import { UnknownEntity } from "./errors.js";
import { authorizedKeys, commitResolution, didcommDocumentOf, pinnedResolver, readResolution } from "./evidence.js";
import { secretsOf } from "./keyring.js";
import { sealData } from "./link.js";
import { serially } from "./procedure.js";
import { knownLongForms, resolve, type Resolution, type Resolved, type ResolverOptions } from "./resolver.js";
import { noteAll, type Note } from "./trace.js";

/** The failure code of an outbound whose expiry passed before it was submitted. */
export const EXPIRED = "expired";
/** The failure code of a first package whose recipient could not be resolved to a key the relationship pins: a definitive resolution failure, or a document that authorizes none of the pinned keys. */
export const PEER_KEY_CHANGED = "peer-key-changed";
/** The most bytes a message's body or one attachment payload may run to and still go on the wire. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

const REPACKED = "repacked";
/** How many times the fold may move the question while its answer is fetched before the attempt is given up as unavailable. */
const MOST_ASKINGS = 3;

export interface PrepareOptions extends ResolverOptions {
  didcomm: DidcommApi;
  /** the clock expiry is compared with, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
}

export type Prepared =
  | {
      outcome: "prepared";
      messageId: MessageId;
      packageId: PackageId;
      prepared: VaultEvent<"message.prepared">;
      /** the packages retired for this one, on a repack */
      retired: VaultEvent<"message.packageRetired">[];
      /** the binding committed for a birth the fold did not hold yet; null when the relationship was bound already */
      bound: VaultEvent<"relationship.bound"> | null;
      /** the fresh resolution recorded for a first package to a peer that is not a numalgo-4 DID; null when none was needed */
      resolved: VaultEvent<"peer.resolved"> | null;
    }
  /** nothing to prepare: the message is closed, a package awaits submission, or the evidence it needs is not here */
  | { outcome: "none"; messageId: MessageId; because: string }
  /** the recipient could not be resolved now; the message stays queued */
  | { outcome: "unavailable"; messageId: MessageId; reason: string }
  /** a terminal failure was recorded: `expired`, or `peer-key-changed` */
  | { outcome: "failed"; messageId: MessageId; code: string; failed: VaultEvent<"delivery.failed"> };

/** The key every piece of work on one outbound runs under, serially per runtime (`serially`): its preparation here, its submission after. */
export function outboundWorkKey(messageId: MessageId): string {
  return `outbound ${messageId}`;
}

/**
 * Prepare the package a queued or repackable outbound is owed, from
 * the fold as it stands: one `message.prepared` with its envelope, the
 * packages it replaces retired in the same batch, and before it, when
 * the pair was born offline, the binding that pins the peer's document.
 * A first package to a peer that is not a numalgo-4 DID resolves the
 * peer afresh first; that no answer came leaves the message queued,
 * an answer that closes the attempt fails it for good. One message is
 * prepared by one caller at a time.
 */
export function prepare(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: PrepareOptions): Promise<Prepared> {
  return serially(runtime, outboundWorkKey(messageId), () => prepareSerially(runtime, keys, messageId, options));
}

/** Prepare every outbound the fold says is owed a package, in message order: what a worker runs between operations and recovery runs on open. */
export async function prepareAll(runtime: VaultRuntime, keys: Keys, options: PrepareOptions): Promise<Prepared[]> {
  const fold = await scanVault(runtime.vault, keys);
  const results: Prepared[] = [];
  for (const outbound of fold.outbound.outbounds.values()) {
    if (outbound.work.kind === "prepare" || outbound.work.kind === "repack") results.push(await prepare(runtime, keys, outbound.messageId, options));
  }
  return results;
}

type Open = { outbound: Outbound; intent: MessageOut };

/** What was asked of the network before the lock: the DID the fold wanted resolved, and the answer; nothing, when the pinned evidence was all a package needs. */
type Asked = { target: Did | null; answer: Resolved | null };

/** What one locked step ends in: a result, or null when the fold no longer asks what was answered and the question is to be asked again. */
type Settled = { result: Prepared | null; notes: Note[] };

async function prepareSerially(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: PrepareOptions): Promise<Prepared> {
  const now = options.now ?? Date.now;
  const trace = options.trace ?? null;
  for (let asking = 1; ; asking++) {
    const fold = await scanVault(runtime.vault, keys);
    const open = openWork(fold, messageId);
    if ("because" in open) return { outcome: "none", messageId, because: open.because };
    const asked: Asked = { target: null, answer: null };
    if (!hasExpired(open.intent, now)) {
      asked.target = targetOf(fold, open);
      if (asked.target !== null) {
        asked.answer = await resolve(asked.target, knownLongForms(fold), options);
        if (asked.answer.outcome === "unavailable") return { outcome: "unavailable", messageId, reason: asked.answer.reason };
      }
    }
    const { result, notes } = await runtime.locked((held) => settle(held, keys, messageId, asked, now, options.didcomm));
    await noteAll(trace, notes);
    if (result !== null) return result;
    if (asking >= MOST_ASKINGS) return { outcome: "unavailable", messageId, reason: `the relationship changed under each of ${asking} resolutions of its peer` };
  }
}

async function settle(held: Held, keys: Keys, messageId: MessageId, asked: Asked, now: () => number, didcomm: DidcommApi): Promise<Settled> {
  const notes: Note[] = [];
  const none = (because: string): Settled => ({ result: { outcome: "none", messageId, because }, notes });
  const failed = async (code: string, reason: string): Promise<Settled> => {
    const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, scope: "message", packageId: null, code })])).map(readVaultEvent);
    notes.push({ stream: "diag", what: "delivery", data: { messageId, code, reason } });
    return { result: { outcome: "failed", messageId, code, failed: event as VaultEvent<"delivery.failed"> }, notes };
  };
  let fold = await scanVault(held, keys);
  let open = openWork(fold, messageId);
  if ("because" in open) return none(open.because);
  if (hasExpired(open.intent, now)) return failed(EXPIRED, "the expiry passed before preparation");
  if (targetOf(fold, open) !== asked.target) return { result: null, notes };
  const { answer } = asked;
  if (answer !== null && answer.outcome !== "resolved") return failed(PEER_KEY_CHANGED, answer.reason);
  const resolution = answer === null ? null : answer.resolution;
  let bound: VaultEvent<"relationship.bound"> | null = null;
  if (!isBound(fold.relationships.relationships.get(open.intent.relationshipId))) {
    const birth = await bind(held, keys, fold, open.intent, resolution as Resolution);
    if ("because" in birth) return none(birth.because);
    if ("code" in birth) return failed(birth.code, birth.reason);
    bound = birth.bound;
    fold = await scanVault(held, keys);
    open = openWork(fold, messageId);
    if ("because" in open) return none(open.because);
  }
  const relationship = fold.relationships.relationships.get(open.intent.relationshipId) as Relationship;
  const selected = await selectEnds(held, keys, fold, relationship, resolution !== null && !isPeerDID4(resolution.did) ? resolution : null);
  if ("because" in selected) return none(selected.because);
  if ("code" in selected) return failed(selected.code, selected.reason);
  const content = await readContent(held, open.intent);
  if ("because" in content) return none(content.because);
  const plaintext = wirePlaintext(intentOfOutbound(open.intent, content.document), { from: selected.from, to: [selected.to], fromPrior: selected.fromPrior }, (root) => content.payloads.get(root) as Uint8Array);
  const packed = await pack(fold, selected, plaintext, didcomm);
  const envelope = parseStrict(packed);
  if (!isJsonObject(envelope)) throw new TypeError("the encrypted envelope is a JSON object");
  const bytes = canonicalize(envelope);
  const envelopeCid = rawCidOfBytes(bytes);
  const packageId = uuidv7() as PackageId;
  const retiring = open.outbound.work.kind === "repack" ? open.outbound.work.packageIds : [];
  const drafts: VaultDraft[] = retiring.map((retired) => vaultDraft("message.packageRetired", { messageId, packageId: retired, because: REPACKED, replacementPackageId: packageId }));
  drafts.push(
    vaultDraft("message.prepared", {
      messageId,
      packageId,
      senderDidId: selected.sender.didId,
      localKeyName: selected.sender.keyNames.keyAgreement,
      recipientDid: selected.to,
      peerResolutionEventId: selected.named.eventId as EventReference<"peer.resolved">,
      fromPrior: selected.fromPrior,
      intentHash: open.intent.intentHash,
      plaintextHash: plaintextHash(plaintext),
      envelopeCid,
    })
  );
  const events = (await held.commit([{ cid: envelopeCid, source: bytes }], drafts)).map(readVaultEvent);
  notes.push({ stream: "envelope", what: "seal", data: { ...sealData(packed, plaintext as unknown as IMessage), messageId, packageId } });
  return {
    result: {
      outcome: "prepared",
      messageId,
      packageId,
      prepared: events.find((event) => event.type === "message.prepared") as VaultEvent<"message.prepared">,
      retired: events.filter((event): event is VaultEvent<"message.packageRetired"> => event.type === "message.packageRetired"),
      bound,
      resolved: selected.recorded,
    },
    notes,
  };
}

function openWork(fold: VaultFold, messageId: MessageId): Open | { because: string } {
  const outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const { work } = outbound;
  if (work.kind === "none") return { because: work.because };
  if (work.kind === "submit") return { because: `package ${work.packageIds.join(", ")} awaits submission` };
  return { outbound, intent: outbound.intent as MessageOut };
}

/** Has the intent's expiry passed by `now`? Equality counts as passed. */
export function hasExpired(intent: MessageOut, now: () => number): boolean {
  return intent.expiresTime !== null && now() >= intent.expiresTime * 1000;
}

function isBound(relationship: Relationship | undefined): boolean {
  return relationship !== undefined && relationship.bindingEventIds.length > 0;
}

/**
 * The DID the fold wants resolved before this package, or null when
 * the pinned evidence is all it needs. A birth no binding holds yet
 * wants its peer, under the exact spelling the intent froze. A bound
 * relationship wants its current peer end for the first package of a
 * message only, and only when that end is not a numalgo-4 DID: the
 * long form's retained document is the document, and nothing fresher
 * exists to ask for.
 */
function targetOf(fold: VaultFold, { outbound, intent }: Open): Did | null {
  const relationship = fold.relationships.relationships.get(intent.relationshipId);
  if (!isBound(relationship)) return (intent.birth as NonNullable<MessageOut["birth"]>).peerDid;
  const peer = (relationship as Relationship).currentPeerDid as Did;
  return !isPeerDID4(peer) && outbound.packages.size === 0 ? peer : null;
}

/**
 * The key-agreement methods of a resolved document that authcrypt from
 * `sender` can seal to, in the document's order. The document may
 * authorize more: a method of a suite didcomm does not pack with, which
 * its projection marks `Other`, or a key on another curve than the
 * sender's, since didcomm agrees both ends over one curve. Either is
 * authorized and still unusable here, and naming it as the recipient
 * key ID would fail the seal.
 */
function sealable(resolution: Resolution, sender: DidKeys): [DidUrl, PublicKey][] {
  const projected = didcommDocumentOf(resolution, resolution.document["id"] as string);
  const packable = new Set(projected.verificationMethod.filter((method) => method.type !== "Other").map((method) => method.id));
  return [...authorizedKeys(resolution, "keyAgreement")].filter(([id, key]) => packable.has(id) && decodePublicKey(key).type === sender.keyAgreement.type);
}

/**
 * The binding of a pair born offline, under the lock: the pair looked
 * up again — another relationship's histories holding it, or a claim
 * awaiting its evidence, stops the package — then the peer's document
 * committed as the resolution at the birth address's key, and the
 * binding that pins it. A reverse-direction receipt that bound the
 * pair meanwhile is found by the caller's rescan, not here.
 */
async function bind(held: Held, keys: Keys, fold: VaultFold, intent: MessageOut, resolution: Resolution): Promise<{ bound: VaultEvent<"relationship.bound"> } | { because: string } | { code: string; reason: string }> {
  const birth = intent.birth as NonNullable<MessageOut["birth"]>;
  const entity = fold.routes.dids.get(birth.localDidId);
  if (entity === undefined || entity.created === null || !entity.live) return { because: `the birth local DID ${birth.localDidId} is not live` };
  const localDid = entity.created.did;
  const claimants = fold.relationships.claimants(localDid, resolution.did).filter((claimant) => claimant !== intent.relationshipId);
  if (claimants.length > 0) return { because: `the pair ${localDid} / ${resolution.did} is claimed by ${claimants.join(", ")}` };
  const pending = fold.relationships.pendingAt(localDid, resolution.did);
  if (pending.length > 0) return { because: `the pair ${localDid} / ${resolution.did} awaits the evidence of ${pending.flatMap((claim) => claim.eventIds).join(", ")}` };
  const [chosen] = sealable(resolution, await keys.didKeys(birth.localDidId));
  if (chosen === undefined) return { code: PEER_KEY_CHANGED, reason: `${resolution.presentedDid} authorizes no key-agreement key ${localDid} can seal to` };
  const evidence = await commitResolution(held, { resolution, localKeyName: entity.keyNames.keyAgreement, peerPublicKey: chosen[1] }, { fresh: !isPeerDID4(resolution.did) });
  const [bound] = (await held.commit([], [vaultDraft("relationship.bound", { relationshipId: intent.relationshipId, localDidId: birth.localDidId, peerResolutionEventId: evidence.eventId as EventReference<"peer.resolved"> })])).map(readVaultEvent);
  return { bound: bound as VaultEvent<"relationship.bound"> };
}

interface Selected {
  sender: LocalNode;
  senderKeys: DidKeys;
  /** the sender's spelling: the long form until the peer's input has confirmed the address, the short form after */
  from: Did;
  fromPrior: string | null;
  /** the recipient: the current peer end, canonical */
  to: Did;
  /** the recipient's key-agreement method, under the pinned document's own spelling */
  methodId: DidUrl;
  /** the pinned document, what the envelope is sealed against */
  pinned: Resolution;
  /** the `peer.resolved` the package names: the pinned snapshot at the sender's key and the selected peer key */
  named: VaultEvent<"peer.resolved">;
  /** the fresh resolution recorded beside it, when one was made */
  recorded: VaultEvent<"peer.resolved"> | null;
}

/**
 * The two current ends of a bound relationship and the evidence between
 * them. The recipient key is one the pinned document authorizes, the
 * sender can seal to and, when a fresh document was resolved, one that
 * document still authorizes: a fresh resolution offering none of the
 * pinned keys is the peer's key changed under the same DID, which is
 * terminal for the message and extends no chain. The package names the
 * pinned snapshot under the sender's key, which is the fresh event
 * itself when the document is unchanged and a re-expression of the pin
 * otherwise; the fresh evidence is recorded either way.
 */
async function selectEnds(held: Held, keys: Keys, fold: VaultFold, relationship: Relationship, current: Resolution | null): Promise<Selected | { because: string } | { code: string; reason: string }> {
  const sender = relationship.localChain.at(-1) as LocalNode;
  const entity = fold.routes.dids.get(sender.didId);
  if (entity === undefined || entity.created === null || !entity.live) return { because: `the current local DID ${sender.didId} is not live` };
  const peerNode = relationship.peerChain.at(-1) as PeerNode;
  const pinnedEvent = fold.set.resolve(peerNode.resolutionEventId, "peer.resolved");
  if (pinnedEvent.status !== "present") return { because: `the resolution ${peerNode.resolutionEventId} pinning ${peerNode.did} is not here` };
  const pinned = await readResolution(pinnedEvent.event, objectReader(held.objects));
  if (pinned === null) return { because: `the document ${peerNode.documentCid} pinned for ${peerNode.did} is not here` };
  const senderKeys = await keys.didKeys(sender.didId);
  let usable = sealable(pinned, senderKeys);
  if (current !== null) {
    const offered = new Set(authorizedKeys(current, "keyAgreement").values());
    usable = usable.filter(([, key]) => offered.has(key));
  }
  const chosen = usable.find(([, key]) => key === pinnedEvent.event.data.peerPublicKey) ?? usable[0];
  if (chosen === undefined) return { code: PEER_KEY_CHANGED, reason: current === null ? `the document pinned for ${peerNode.did} authorizes no key-agreement key ${entity.created.did} can seal to` : `${current.presentedDid} no longer authorizes a key the relationship pins` };
  const [methodId, peerPublicKey] = chosen;
  const localKeyName = sender.keyNames.keyAgreement;
  let recorded: VaultEvent<"peer.resolved"> | null = null;
  let named: VaultEvent<"peer.resolved">;
  if (current !== null) {
    recorded = await commitResolution(held, { resolution: current, localKeyName, peerPublicKey }, { fresh: true });
    named = current.cid === pinned.cid ? recorded : await commitResolution(held, { resolution: pinned, localKeyName, peerPublicKey });
  } else {
    named = await commitResolution(held, { resolution: pinned, localKeyName, peerPublicKey });
  }
  const confirmed = confirmedKeyNames(fold, relationship.relationshipId);
  const confirmedHere = confirmed.has(sender.keyNames.keyAgreement) || confirmed.has(sender.keyNames.authentication);
  let fromPrior: string | null = null;
  if (!confirmedHere && sender.edgeEventIds.length > 0) {
    const edge = fold.set.resolve(sender.edgeEventIds[0] as EventReference<"relationship.localTransitioned">, "relationship.localTransitioned");
    if (edge.status !== "present") return { because: `the transition ${sender.edgeEventIds[0]} adding ${sender.didId} is not here` };
    fromPrior = edge.event.data.fromPrior;
  }
  return {
    sender,
    senderKeys,
    from: confirmedHere ? entity.created.did : entity.created.longFormDid,
    fromPrior,
    to: peerNode.did,
    methodId,
    pinned,
    named,
    recorded,
  };
}

/** The local keys scoped input has arrived at in a relationship, each in a group that does not contradict: what confirms a local address to its peer. */
export function confirmedKeyNames(fold: VaultFold, relationshipId: RelationshipId): Set<KeyName> {
  const names = new Set<KeyName>();
  for (const receipt of fold.set.of("message.in")) {
    const scope = fold.relationships.observations.get(receipt.eventId);
    if (scope?.status !== "scoped" || scope.relationshipId !== relationshipId || fold.relationships.groups.get(receipt.data.messageId)?.status === "conflict") continue;
    names.add(receipt.data.localKeyName);
  }
  return names;
}

type Content = { document: ReturnType<typeof readStoredDocument>; payloads: Map<Cid, Uint8Array> };

/** An object that is damaged or too large for the wire is a reason the package cannot be made now, not a throw. */
async function readContent(held: Held, intent: MessageOut): Promise<Content | { because: string }> {
  const read = async (cid: Cid): Promise<Uint8Array | null> => {
    try {
      return await held.objects.read(cid, MAX_CONTENT_BYTES);
    } catch (err) {
      if (err instanceof DamagedObject || err instanceof ObjectTooLarge) return null;
      throw err;
    }
  };
  const bytes = await read(intent.bodyCid);
  if (bytes === null) return { because: `the body ${intent.bodyCid} is not here` };
  const document = readStoredDocument(parseStrict(bytes));
  const payloads = new Map<Cid, Uint8Array>();
  for (const attachment of document.attachments) {
    if (attachment.data.kind === "links") continue;
    const payload = await read(attachment.data.root);
    if (payload === null) return { because: `the attachment ${attachment.data.root} is not here` };
    payloads.set(attachment.data.root, payload);
  }
  return { document, payloads };
}

/**
 * The plaintext sealed as authcrypt from the sender's key-agreement key
 * to the one recipient key selected, both named as key IDs so that
 * didcomm seals to exactly those: the sender's under the spelling the
 * plaintext carries, the recipient's under the canonical DID the
 * plaintext addresses. The documents are answered from the fold and the
 * pinned snapshot; nothing is resolved again.
 */
async function pack(fold: VaultFold, selected: Selected, plaintext: JsonObject, didcomm: DidcommApi): Promise<string> {
  const entity = fold.routes.dids.get(selected.sender.didId);
  if (entity === undefined || entity.created === null) throw new UnknownEntity("DID", selected.sender.didId);
  const senderKid = selected.from + splitDidUrl(entity.methodIds.keyAgreement[0] as string)[1];
  const recipientKid = selected.to + splitDidUrl(selected.methodId)[1];
  const secrets = secretsOf(selected.senderKeys, [entity.created.longFormDid, entity.created.did], entity.methodIds);
  const resolver = pinnedResolver(fold, { current: [selected.pinned] });
  const [packed] = await new didcomm.Message(plaintext as unknown as IMessage).pack_encrypted(recipientKid, senderKid, null, resolver, secretsResolverFor(secrets), { forward: false });
  return packed;
}
