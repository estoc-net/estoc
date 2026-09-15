/**
 * Preparing turns a queued intent into the one exact envelope its
 * submission will carry. The intent chose the relationship; preparing
 * chooses nothing about it, only reads its current ends: the sender is
 * the current local end, under its long form and with the proof of the
 * transition that added it until the peer's input has confirmed it; the
 * recipient is the current peer end, at a key its pinned document
 * authorizes. What the network has to say is asked before the lock — a
 * fresh document for a first package to a peer that is not a numalgo-4
 * DID — and everything the answer changes is decided under it, over the
 * fold read again: a pair whose birth no binding holds yet is bound
 * first, then the package is built, packed, canonicalized and committed
 * with its envelope in one batch. Nothing here submits; the package
 * waits for the outbox with its exact bytes.
 */

import { v7 as uuidv7 } from "uuid";

import { isPeerDID4 } from "@estoc/did-peer";
import { DamagedObject, ObjectTooLarge, canonicalize, isJsonObject, parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import {
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
  type DidId,
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
  type Relationship,
  type RelationshipId,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import { secretsResolverFor, type DidcommApi, type IMessage } from "../protocol/didcomm.js";
import { UnknownEntity } from "./errors.js";
import { authorizedKeys, commitResolution, pinnedResolver, readResolution } from "./evidence.js";
import { secretsOf } from "./keyring.js";
import { sealData } from "./link.js";
import { knownLongForms, resolve, type Resolution, type ResolverOptions } from "./resolver.js";
import type { AgentTrace } from "./trace.js";

/** The failure code of an outbound whose expiry passed before it was submitted. */
export const EXPIRED = "expired";
/** The failure code of a first package whose recipient could not be resolved to a key the relationship pins: a definitive resolution failure, or a document that authorizes none of the pinned keys. */
export const PEER_KEY_CHANGED = "peer-key-changed";
/** The most bytes a message's body or one attachment payload may run to and still go on the wire. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

const REPACKED = "repacked";

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

type Open = { outbound: Outbound; intent: MessageOut };

/**
 * Prepare the package a queued or repackable outbound is owed, from
 * the fold as it stands: one `message.prepared` with its envelope, the
 * packages it replaces retired in the same batch, and before it, when
 * the pair was born offline, the binding that pins the peer's document.
 * A first package to a peer that is not a numalgo-4 DID resolves the
 * peer afresh first; that no answer came leaves the message queued,
 * an answer that closes the attempt fails it for good.
 */
export async function prepare(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: PrepareOptions): Promise<Prepared> {
  const now = options.now ?? Date.now;
  const trace = options.trace ?? null;
  const first = await scanVault(runtime.vault, keys);
  const queued = openWork(first, messageId);
  if ("because" in queued) return { outcome: "none", messageId, because: queued.because };
  if (expired(queued.intent, now)) return fail(runtime, keys, messageId, EXPIRED, "the expiry passed before preparation", trace);
  const target = targetOf(first, queued);
  let resolution: Resolution | null = null;
  if (target !== null) {
    const resolved = await resolve(target, knownLongForms(first), options);
    if (resolved.outcome === "unavailable") return { outcome: "unavailable", messageId, reason: resolved.reason };
    if (resolved.outcome === "definitive") return fail(runtime, keys, messageId, PEER_KEY_CHANGED, resolved.reason, trace);
    resolution = resolved.resolution;
  }
  return runtime.locked(async (held) => {
    let fold = await scanVault(held, keys);
    let open = openWork(fold, messageId);
    if ("because" in open) return { outcome: "none", messageId, because: open.because };
    if (expired(open.intent, now)) return failHeld(held, messageId, EXPIRED, "the expiry passed before preparation", trace);
    let bound: VaultEvent<"relationship.bound"> | null = null;
    if (!isBound(fold.relationships.relationships.get(open.intent.relationshipId))) {
      const birth = await bind(held, fold, open.intent, resolution as Resolution);
      if ("because" in birth) return { outcome: "none", messageId, because: birth.because };
      if ("code" in birth) return failHeld(held, messageId, birth.code, birth.reason, trace);
      bound = birth.bound;
      fold = await scanVault(held, keys);
      open = openWork(fold, messageId);
      if ("because" in open) return { outcome: "none", messageId, because: open.because };
    }
    const relationship = fold.relationships.relationships.get(open.intent.relationshipId) as Relationship;
    const selected = await selectEnds(held, fold, relationship, resolution !== null && !isPeerDID4(resolution.did) ? resolution : null);
    if ("because" in selected) return { outcome: "none", messageId, because: selected.because };
    if ("code" in selected) return failHeld(held, messageId, selected.code, selected.reason, trace);
    const content = await readContent(held, open.intent);
    if ("because" in content) return { outcome: "none", messageId, because: content.because };
    const plaintext = wirePlaintext(intentOfOutbound(open.intent, content.document), { from: selected.from, to: [selected.to], fromPrior: selected.fromPrior }, (root) => content.payloads.get(root) as Uint8Array);
    const packed = await pack(fold, keys, selected, plaintext, options.didcomm);
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
        senderDidId: selected.senderDidId,
        localKeyName: selected.localKeyName,
        recipientDid: selected.to,
        peerResolutionEventId: selected.named.eventId as EventReference<"peer.resolved">,
        fromPrior: selected.fromPrior,
        intentHash: open.intent.intentHash,
        plaintextHash: plaintextHash(plaintext),
        envelopeCid,
      })
    );
    const events = (await held.commit([{ cid: envelopeCid, source: bytes }], drafts)).map(readVaultEvent);
    await trace?.append("envelope", "seal", { ...sealData(packed, plaintext as unknown as IMessage), messageId, packageId });
    return {
      outcome: "prepared",
      messageId,
      packageId,
      prepared: events.find((event) => event.type === "message.prepared") as VaultEvent<"message.prepared">,
      retired: events.filter((event): event is VaultEvent<"message.packageRetired"> => event.type === "message.packageRetired"),
      bound,
      resolved: selected.recorded,
    };
  });
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

/** The outbound while the fold says a package is to be prepared for it; otherwise why not. */
function openWork(fold: VaultFold, messageId: MessageId): Open | { because: string } {
  const outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const { work } = outbound;
  if (work.kind === "none") return { because: work.because };
  if (work.kind === "submit") return { because: `package ${work.packageIds.join(", ")} awaits submission` };
  return { outbound, intent: outbound.intent as MessageOut };
}

function expired(intent: MessageOut, now: () => number): boolean {
  return intent.expiresTime !== null && now() >= intent.expiresTime * 1000;
}

function isBound(relationship: Relationship | undefined): boolean {
  return relationship !== undefined && relationship.bindingEventIds.length > 0;
}

/**
 * The DID to resolve before the lock, or null when the pinned
 * evidence is all a package needs: a birth's peer, under the exact
 * spelling the intent froze; a bound relationship's current peer end,
 * only for the first package of a message to a peer that is not a
 * numalgo-4 DID, whose retained document needs no fresh resolution.
 */
function targetOf(fold: VaultFold, { outbound, intent }: Open): Did | null {
  const relationship = fold.relationships.relationships.get(intent.relationshipId);
  if (!isBound(relationship)) return (intent.birth as NonNullable<MessageOut["birth"]>).peerDid;
  const peer = (relationship as Relationship).currentPeerDid as Did;
  return !isPeerDID4(peer) && outbound.packages.size === 0 ? peer : null;
}

/** The terminal failure of a message, under the lock, once the fold still says the message is open. */
async function fail(runtime: VaultRuntime, keys: Keys, messageId: MessageId, code: string, reason: string, trace: AgentTrace | null): Promise<Prepared> {
  return runtime.locked(async (held) => {
    const open = openWork(await scanVault(held, keys), messageId);
    if ("because" in open) return { outcome: "none", messageId, because: open.because };
    return failHeld(held, messageId, code, reason, trace);
  });
}

/** The message-scoped failure committed; the reason, which the event does not carry, goes to the local diagnostics. */
async function failHeld(held: Held, messageId: MessageId, code: string, reason: string, trace: AgentTrace | null): Promise<Prepared> {
  const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, scope: "message", packageId: null, code })])).map(readVaultEvent);
  await trace?.append("diag", "delivery", { messageId, code, reason });
  return { outcome: "failed", messageId, code, failed: event as VaultEvent<"delivery.failed"> };
}

/**
 * The binding of a pair born offline, under the lock: the pair looked
 * up again — another relationship's histories holding it, or a claim
 * awaiting its evidence, stops the package — then the peer's document
 * committed as the resolution at the birth address's key, and the
 * binding that pins it. A reverse-direction receipt that bound the
 * pair meanwhile is found by the caller's rescan, not here.
 */
async function bind(held: Held, fold: VaultFold, intent: MessageOut, resolution: Resolution): Promise<{ bound: VaultEvent<"relationship.bound"> } | { because: string } | { code: string; reason: string }> {
  const birth = intent.birth as NonNullable<MessageOut["birth"]>;
  const entity = fold.routes.dids.get(birth.localDidId);
  if (entity === undefined || entity.created === null || !entity.live) return { because: `the birth local DID ${birth.localDidId} is not live` };
  const localDid = entity.created.did;
  const claimants = fold.relationships.claimants(localDid, resolution.did).filter((claimant) => claimant !== intent.relationshipId);
  if (claimants.length > 0) return { because: `the pair ${localDid} / ${resolution.did} is claimed by ${claimants.join(", ")}` };
  const pending = fold.relationships.pendingAt(localDid, resolution.did);
  if (pending.length > 0) return { because: `the pair ${localDid} / ${resolution.did} awaits the evidence of ${pending.flatMap((claim) => claim.eventIds).join(", ")}` };
  const [key] = authorizedKeys(resolution, "keyAgreement").values();
  if (key === undefined) return { code: PEER_KEY_CHANGED, reason: `${resolution.presentedDid} authorizes no key-agreement key this vault can use` };
  const evidence = await commitResolution(held, { resolution, localKeyName: entity.keyNames.keyAgreement, peerPublicKey: key }, { fresh: !isPeerDID4(resolution.did) });
  const [bound] = (await held.commit([], [vaultDraft("relationship.bound", { relationshipId: intent.relationshipId, localDidId: birth.localDidId, peerResolutionEventId: evidence.eventId as EventReference<"peer.resolved"> })])).map(readVaultEvent);
  return { bound: bound as VaultEvent<"relationship.bound"> };
}

/** What one package is built from: its two ends, the key at each, the evidence it names and the proof it carries. */
interface Selected {
  senderDidId: DidId;
  localKeyName: KeyName;
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
 * them. The recipient key is one the pinned document authorizes and,
 * when a fresh document was resolved, one that document still
 * authorizes: a fresh resolution offering none of the pinned keys is
 * the peer's key changed under the same DID, which is terminal for the
 * message and extends no chain. The package names the pinned snapshot
 * under the sender's key, which is the fresh event itself when the
 * document is unchanged and a re-expression of the pin otherwise; the
 * fresh evidence is recorded either way.
 */
async function selectEnds(held: Held, fold: VaultFold, relationship: Relationship, current: Resolution | null): Promise<Selected | { because: string } | { code: string; reason: string }> {
  const node = relationship.localChain.at(-1) as LocalNode;
  const entity = fold.routes.dids.get(node.didId);
  if (entity === undefined || entity.created === null || !entity.live) return { because: `the current local DID ${node.didId} is not live` };
  const peerNode = relationship.peerChain.at(-1) as PeerNode;
  const pinnedEvent = fold.set.resolve(peerNode.resolutionEventId, "peer.resolved");
  if (pinnedEvent.status !== "present") return { because: `the resolution ${peerNode.resolutionEventId} pinning ${peerNode.did} is not here` };
  const pinned = await readResolution(pinnedEvent.event, objectReader(held.objects));
  if (pinned === null) return { because: `the document ${peerNode.documentCid} pinned for ${peerNode.did} is not here` };
  let usable = [...authorizedKeys(pinned, "keyAgreement")];
  if (current !== null) {
    const offered = new Set(authorizedKeys(current, "keyAgreement").values());
    usable = usable.filter(([, key]) => offered.has(key));
  }
  const chosen = usable.find(([, key]) => key === pinnedEvent.event.data.peerPublicKey) ?? usable[0];
  if (chosen === undefined) return { code: PEER_KEY_CHANGED, reason: current === null ? `the document pinned for ${peerNode.did} authorizes no key-agreement key this vault can use` : `${current.presentedDid} no longer authorizes a key the relationship pins` };
  const [methodId, peerPublicKey] = chosen;
  const localKeyName = node.keyNames.keyAgreement;
  let recorded: VaultEvent<"peer.resolved"> | null = null;
  let named: VaultEvent<"peer.resolved">;
  if (current !== null) {
    recorded = await commitResolution(held, { resolution: current, localKeyName, peerPublicKey }, { fresh: true });
    named = current.cid === pinned.cid ? recorded : await commitResolution(held, { resolution: pinned, localKeyName, peerPublicKey });
  } else {
    named = await commitResolution(held, { resolution: pinned, localKeyName, peerPublicKey });
  }
  const confirmed = confirmedKeyNames(fold, relationship.relationshipId);
  const confirmedHere = confirmed.has(node.keyNames.keyAgreement) || confirmed.has(node.keyNames.authentication);
  let fromPrior: string | null = null;
  if (!confirmedHere && node.edgeEventIds.length > 0) {
    const edge = fold.set.resolve(node.edgeEventIds[0] as EventReference<"relationship.localTransitioned">, "relationship.localTransitioned");
    if (edge.status !== "present") return { because: `the transition ${node.edgeEventIds[0]} adding ${node.didId} is not here` };
    fromPrior = edge.event.data.fromPrior;
  }
  return {
    senderDidId: node.didId,
    localKeyName,
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
function confirmedKeyNames(fold: VaultFold, relationshipId: RelationshipId): Set<KeyName> {
  const names = new Set<KeyName>();
  for (const receipt of fold.set.of("message.in")) {
    const scope = fold.relationships.observations.get(receipt.eventId);
    if (scope?.status !== "scoped" || scope.relationshipId !== relationshipId || fold.relationships.groups.get(receipt.data.messageId)?.status === "conflict") continue;
    names.add(receipt.data.localKeyName);
  }
  return names;
}

type Content = { document: ReturnType<typeof readStoredDocument>; payloads: Map<Cid, Uint8Array> };

/** The stored document and every inline attachment payload the intent names, read from the objects; why not, when one is not here. */
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
async function pack(fold: VaultFold, keys: Keys, selected: Selected, plaintext: JsonObject, didcomm: DidcommApi): Promise<string> {
  const entity = fold.routes.dids.get(selected.senderDidId);
  if (entity === undefined || entity.created === null) throw new UnknownEntity("DID", selected.senderDidId);
  const senderKid = selected.from + splitDidUrl(entity.methodIds.keyAgreement[0] as string)[1];
  const recipientKid = selected.to + splitDidUrl(selected.methodId)[1];
  const secrets = secretsOf(await keys.didKeys(selected.senderDidId), [entity.created.longFormDid, entity.created.did], entity.methodIds);
  const resolver = pinnedResolver(fold, { current: [selected.pinned] });
  const [packed] = await new didcomm.Message(plaintext as unknown as IMessage).pack_encrypted(recipientKid, senderKid, null, resolver, secretsResolverFor(secrets), { forward: false });
  return packed;
}
