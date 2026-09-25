/**
 * Preparing turns a queued intent into the one exact envelope every
 * transport call of it will carry. The intent fixed the channel;
 * preparing chooses nothing about it, only reads what the channel
 * needs on the wire: the sender under its long form until the peer has
 * written to that address and under its short form after, with the
 * frozen proof of the rotation that made it a successor while that
 * address is unconfirmed; the recipient under its short form, at a
 * key-agreement key its retained document authorizes and the sender's
 * key can agree with. The intent keeps the spelling it was given so
 * that a long form resolves offline; once resolved, the wire names the
 * canonical DID. Nothing is asked of the network: a numalgo-4 peer
 * resolves from its long form, and a short form whose long form is not
 * in evidence waits, which is not a key change.
 * Everything is decided under the writer lock over the fold read
 * there, and the envelope object, the resolution evidence and the
 * package are committed in that one lock; the fold holds the package
 * from then on, whatever rotates, confirms or resolves later. A
 * resolution committed here is evidence an observation may have
 * waited for — the document of the issuer of the proof it carried —
 * so what the vault owes is recorded under the same lock once the
 * message has its package, made now or held already, before the
 * package's dispatch or any other work reads the fold. That pass is
 * owed by every preparation, not only the one that committed the
 * resolution: a commit refused after the resolution was durable, the
 * package's or the pass's own, leaves the resolution in the fold and
 * the work over it undone, and the next preparation or dispatch of
 * any message completes it.
 */

import { v7 as uuidv7 } from "uuid";

import { isShortForm } from "@estoc/did-peer";
import { canonicalize, isJsonObject, parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store";
import {
  InvalidPublicKey,
  agreementKey,
  intentOfOutbound,
  objectReader,
  plaintextHash,
  rawCidOfBytes,
  readStoredDocument,
  readVaultEvent,
  sameChannel,
  scanVault,
  splitDidUrl,
  vaultDraft,
  wirePlaintext,
  type Channel,
  type Cid,
  type Decision,
  type DecodedPublicKey,
  type Did,
  type DidKeys,
  type DidUrl,
  type EventReference,
  type Keys,
  type LocalDidEntity,
  type MessageId,
  type MessageOut,
  type Outbound,
  type Package,
  type PackageId,
  type PublicKey,
  type ScanOptions,
  type StoredMessageDocument,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { packEncrypted, secretsResolverFor, type DidcommApi, type IMessage } from "./protocol/didcomm.js";
import { recordOwedAcceptance } from "./acceptance.js";
import { UnknownEntity } from "./errors.js";
import { authorizedKeys, commitResolution, didcommDocumentOf, pinnedResolver } from "./evidence.js";
import { recordOwedUnderLock } from "./receive/after.js";
import { secretsOf } from "./keyring.js";
import { sealData } from "./link.js";
import { serially } from "./procedure.js";
import { knownLongForms, resolve, type Resolution } from "./resolver.js";
import { noteAll, type AgentTrace, type Note } from "./trace.js";

/** The most bytes a message's body or one attachment payload may run to and still go on the wire. */
export const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

export interface PrepareOptions {
  didcomm: DidcommApi;
  /** the operations beyond the built-in ones whose intents this runtime produces, as its handlers declare them; an intent of another operation is no work of this runtime's */
  effectTypes?: readonly string[];
  /** the seal of every package goes to the `envelope` stream */
  trace?: AgentTrace;
  /** the clock expiry is compared with, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
}

export type Prepared =
  | { outcome: "prepared"; messageId: MessageId; packageId: PackageId; prepared: VaultEvent<"message.prepared">; resolved: VaultEvent<"peer.resolved"> }
  /** the package the fold already holds for the message: no package was written */
  | { outcome: "reused"; messageId: MessageId; package: Package }
  /** the fold asks for no package: the message is closed, in conflict, or not the sender's to prepare now */
  | { outcome: "none"; messageId: MessageId; because: string }
  /** the package cannot be made from what is here now, and what is missing may still arrive: the message stays queued */
  | { outcome: "pending"; messageId: MessageId; because: string }
  /** the expiry had come when the message was looked at, whether or not a package was made: the message is terminated */
  | { outcome: "expired"; messageId: MessageId; failed: VaultEvent<"delivery.failed"> };

/** The key every piece of work on one outbound runs under, serially per runtime (`serially`): its preparation here, its transport call after. */
export function outboundWorkKey(messageId: MessageId): string {
  return `outbound ${messageId}`;
}

/** What every scan over an outbound is told, so that the fold counts the runtime's own operations as its work. */
export function scanOptions(options: Pick<PrepareOptions, "effectTypes">): ScanOptions {
  return options.effectTypes === undefined ? {} : { effectTypes: options.effectTypes };
}

export function hasExpired(intent: MessageOut, now: () => number): boolean {
  return intent.expiresTime !== null && now() >= intent.expiresTime * 1000;
}

/**
 * Why a message takes no more work whatever holds it up otherwise: its
 * intent is in conflict, it is submitted, or it is terminated. Null
 * while it is open. What makes the message wait — a blocked channel,
 * a package whose evidence is not here — comes after this, and after
 * its expiry: an expiry that has come terminates the intent itself,
 * without a package and whatever else the fold says.
 */
export function closedBecause(outbound: Outbound): string | null {
  if (outbound.intent.status === "conflict") return outbound.intent.because;
  if (outbound.submitted) return "submitted";
  if (outbound.terminal !== null) return `terminated: ${outbound.terminal.event.data.code}`;
  return null;
}

/** What the expiry of an open message came before, for the trace: the package it has none of, or the call of the one it has. */
export function expiryPhase(outbound: Outbound): "preparation" | "dispatch" {
  return outbound.package === null ? "preparation" : "dispatch";
}

/** The package of one queued outbound: made here, or the one the fold already holds. An acceptance this runtime saw and has not recorded yet is recorded first, so that the fold read here shows the message submitted rather than open to expiry. */
export function prepare(runtime: VaultRuntime, keys: Keys, messageId: MessageId, options: PrepareOptions): Promise<Prepared> {
  return serially(runtime, outboundWorkKey(messageId), async () => {
    await recordOwedAcceptance(runtime, messageId);
    const { result, notes } = await runtime.locked((held) => prepareUnderLock(held, keys, messageId, options));
    await noteAll(options.trace ?? null, notes);
    return result;
  });
}

/** Every outbound the fold says needs a package, in message order. */
export async function prepareAll(runtime: VaultRuntime, keys: Keys, options: PrepareOptions): Promise<Prepared[]> {
  const fold = await scanVault(runtime.vault, keys, scanOptions(options));
  const results: Prepared[] = [];
  for (const outbound of [...fold.outbound.outbounds.values()].sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0))) {
    if (outbound.work.kind === "prepare") results.push(await prepare(runtime, keys, outbound.messageId, options));
  }
  return results;
}

/** What one locked step came to, and the trace entries it owes once the lock is released. */
export type Settled<T> = { result: T; notes: Note[] };

/** The expired failure of an unsubmitted intent, committed under the lock the caller holds; `phase` says what the expiry came before. */
export async function expireUnderLock(held: Held, messageId: MessageId, phase: "preparation" | "dispatch"): Promise<Settled<Extract<Prepared, { outcome: "expired" }>>> {
  const [event] = (await held.commit([], [vaultDraft("delivery.failed", { messageId, code: "expired" })])).map(readVaultEvent);
  const notes: Note[] = [{ stream: "diag", what: "delivery", data: { messageId, code: "expired", reason: `the expiry passed before ${phase}` } }];
  return { result: { outcome: "expired", messageId, failed: event as VaultEvent<"delivery.failed"> }, notes };
}

/** `prepare` for a caller that already holds the message's turn and the writer lock: the dispatch of a message the fold says needs a package first. */
export async function prepareUnderLock(held: Held, keys: Keys, messageId: MessageId, options: PrepareOptions): Promise<Settled<Prepared>> {
  const notes: Note[] = [];
  const fold = await scanVault(held, keys, scanOptions(options));
  const outbound = fold.outbound.outbounds.get(messageId);
  if (outbound === undefined) throw new UnknownEntity("message", messageId);
  const closed = closedBecause(outbound);
  if (closed !== null) return { result: { outcome: "none", messageId, because: closed }, notes };
  const intent = (outbound.intent as { data: MessageOut }).data;
  if (hasExpired(intent, options.now ?? Date.now)) return expireUnderLock(held, messageId, expiryPhase(outbound));
  const { work } = outbound;
  if (work.kind === "none") return { result: { outcome: "none", messageId, because: work.because }, notes };
  if (work.kind === "dispatch") {
    notes.push(...(await owedRecorded(held, keys, messageId)));
    return { result: { outcome: "reused", messageId, package: work.package }, notes };
  }
  const sender = outbound.sender as LocalDidEntity;
  const channel = outbound.channel as Channel;
  const ends = await endsOf(fold, keys, sender, channel, intent.recipientDid);
  if ("pending" in ends) return { result: { outcome: "pending", messageId, because: ends.pending }, notes };
  if ("because" in ends) return { result: { outcome: "none", messageId, because: ends.because }, notes };
  const content = await readContent(held, intent);
  if ("pending" in content) return { result: { outcome: "pending", messageId, because: content.pending }, notes };
  const plaintext = wirePlaintext(intentOfOutbound(intent, content.document), { from: ends.from, to: [channel.peerDid], fromPrior: ends.fromPrior }, (root) => content.payloads.get(root) as Uint8Array);
  const packed = await pack(fold, sender, ends, plaintext, options.didcomm);
  const envelope = parseStrict(packed);
  if (!isJsonObject(envelope)) throw new TypeError("the encrypted envelope is a JSON object");
  const bytes = canonicalize(envelope);
  const envelopeCid = rawCidOfBytes(bytes);
  const packageId = uuidv7() as PackageId;
  const resolved = await commitResolution(held, { resolution: ends.resolution, localKeyName: sender.keyNames.keyAgreement, peerPublicKey: ends.peerPublicKey });
  const [prepared] = (
    await held.commit(
      [{ cid: envelopeCid, source: bytes }],
      [
        vaultDraft("message.prepared", {
          messageId,
          packageId,
          senderDidId: sender.didId,
          localKeyName: sender.keyNames.keyAgreement,
          recipientDid: channel.peerDid,
          peerResolutionEventCid: resolved.cid as EventReference<"peer.resolved">,
          fromPrior: ends.fromPrior,
          intentHash: intent.intentHash,
          plaintextHash: plaintextHash(plaintext),
          envelopeCid,
        }),
      ]
    )
  ).map(readVaultEvent);
  notes.push({ stream: "envelope", what: "seal", data: { ...sealData(packed, plaintext as unknown as IMessage), messageId, packageId } });
  notes.push(...(await owedRecorded(held, keys, messageId)));
  return { result: { outcome: "prepared", messageId, packageId, prepared: prepared as VaultEvent<"message.prepared">, resolved }, notes };
}

/**
 * The pass over what the vault owes, once the message has its package:
 * an admission whose proof waited for the document a preparation
 * resolved, and what follows one, recorded before the lock is released
 * and dispatched by nothing. The package stands whether the pass ran
 * through or stopped; one that stopped is noted, and left to the next
 * pass, which the next preparation, dispatch, receipt or open runs.
 */
async function owedRecorded(held: Held, keys: Keys, messageId: MessageId): Promise<Note[]> {
  try {
    await recordOwedUnderLock(held, keys);
    return [];
  } catch (err) {
    return [{ stream: "diag", what: "admission", data: { messageId, reason: `the pass the preparation runs stopped: ${err instanceof Error ? err.message : String(err)}` } }];
  }
}

interface Ends {
  senderKeys: DidKeys;
  /** the sender's spelling on the wire: the long form until the peer has written to the address, the short form after */
  from: Did;
  fromPrior: string | null;
  /** the recipient's document, resolved from the long form in evidence */
  resolution: Resolution;
  /** the recipient's key-agreement method, under the document's own spelling */
  methodId: DidUrl;
  peerPublicKey: PublicKey;
}

/**
 * The two ends as the wire names them. A peer key is one the retained
 * document authorizes for key agreement, didcomm can seal to, and on
 * the sender's own curve; the first such in document order. A
 * document authorizing none is not a key change — the document is
 * immutable — but no package to it can be made.
 */
async function endsOf(fold: VaultFold, keys: Keys, sender: LocalDidEntity, channel: Channel, recipientDid: Did): Promise<Ends | { pending: string } | { because: string }> {
  const known = knownLongForms(fold);
  if (isShortForm(recipientDid) && known(recipientDid) === null) return { pending: `no long form of ${recipientDid} is in evidence` };
  const answer = await resolve(recipientDid, known);
  if (answer.outcome !== "resolved") return { because: answer.reason };
  const { resolution } = answer;
  const senderKeys = await keys.didKeys(sender.didId);
  const [chosen] = sealable(resolution, senderKeys);
  if (chosen === undefined) return { because: `${resolution.presentedDid} authorizes no key-agreement key ${channel.localDid} can seal to` };
  const [methodId, peerPublicKey] = chosen;
  const created = sender.created as NonNullable<LocalDidEntity["created"]>;
  const ends = { senderKeys, resolution, methodId, peerPublicKey };
  if (fold.continuity.confirmed(channel.localDid, channel.peerDid)) return { ...ends, from: created.did, fromPrior: null };
  const proof = proofOf(fold, sender, channel);
  if (proof !== null && typeof proof === "object") return proof;
  return { ...ends, from: created.longFormDid, fromPrior: proof };
}

/**
 * The frozen proof a sender carries as an unconfirmed successor: the
 * one of the decision that rotated to it toward this channel's peer,
 * at the pair itself or on a verified role-preserving path to it.
 * Null when no decision made the sender a successor here. A decision
 * that is refused, contradicted or still waiting for its evidence
 * stops the package: the proof it holds is not one to send, and the
 * sender is not to go out proof-free either. Which decisions concern
 * the sender is read off their own fields, since one waiting for its
 * predecessor's creation has no channel in the fold yet.
 */
function proofOf(fold: VaultFold, sender: LocalDidEntity, channel: Channel): string | null | { pending: string } | { because: string } {
  const decisions = [...fold.channels.decisions.values()].filter((decision) => decision.event.data.toDidId === sender.didId && leadsTo(fold, decision, channel));
  if (decisions.length === 0) return null;
  for (const decision of decisions) {
    const { status } = decision;
    if (status.status === "pending") return { pending: `the rotation ${decision.event.cid} to the sender is pending: ${status.because}` };
    if (status.status !== "candidate") return { because: `the rotation ${decision.event.cid} to the sender is ${status.status}: ${status.because}` };
  }
  const proofs = new Set(decisions.map((decision) => decision.event.data.fromPrior));
  if (proofs.size > 1) return { because: `${decisions.length} rotations to the sender toward ${channel.peerDid} freeze different proofs` };
  return decisions[0]!.event.data.fromPrior;
}

/** Does the decision's rotation land in `channel`: its successor's pair with the same peer, or a pair a verified path from there preserves the roles into. */
function leadsTo(fold: VaultFold, decision: Decision, channel: Channel): boolean {
  const landed: Channel = { localDid: channel.localDid, peerDid: decision.event.data.peerDid };
  return sameChannel(landed, channel) || fold.continuity.ackPath(landed, channel);
}

/**
 * The key-agreement methods of a resolved document that authcrypt from
 * `sender` can seal to, in the document's order. The document may
 * authorize more: a method of a suite didcomm does not pack with, which
 * its projection marks `Other`, or a key on another curve than the
 * sender's, since didcomm agrees both ends over one curve; or a key
 * that agrees nothing, a signing key or a low-order point. Each is
 * authorized and still unusable here, and naming it as the recipient
 * key ID would fail the seal.
 */
function sealable(resolution: Resolution, sender: DidKeys): [DidUrl, PublicKey][] {
  const projected = didcommDocumentOf(resolution, resolution.document["id"] as string);
  const packable = new Set(projected.verificationMethod.filter((method) => method.type !== "Other").map((method) => method.id));
  return [...authorizedKeys(resolution, "keyAgreement")].filter(([id, key]) => packable.has(id) && agrees(key, sender.keyAgreement.type));
}

function agrees(key: PublicKey, type: DecodedPublicKey["type"]): boolean {
  try {
    return agreementKey(key).type === type;
  } catch (err) {
    if (err instanceof InvalidPublicKey) return false;
    throw err;
  }
}

type Content = { document: StoredMessageDocument; payloads: Map<Cid, Uint8Array> };

/** An object that is missing, damaged or too large for the wire is a reason the package cannot be made now, not a throw. */
async function readContent(held: Held, intent: MessageOut): Promise<Content | { pending: string }> {
  const read = objectReader(held.objects, MAX_CONTENT_BYTES);
  const bytes = await read(intent.bodyCid);
  if (bytes === null) return { pending: `the body ${intent.bodyCid} is not here` };
  const document = readStoredDocument(parseStrict(bytes));
  const payloads = new Map<Cid, Uint8Array>();
  for (const attachment of document.attachments) {
    if (attachment.data.kind === "links") continue;
    const payload = await read(attachment.data.root);
    if (payload === null) return { pending: `the attachment ${attachment.data.root} is not here` };
    payloads.set(attachment.data.root, payload);
  }
  return { document, payloads };
}

/**
 * The plaintext sealed as authcrypt from the sender's key-agreement key
 * to the one recipient key selected, both named as key IDs so that
 * didcomm seals to exactly those: the sender's under the spelling the
 * plaintext carries, the recipient's under the spelling the plaintext
 * addresses. The documents are answered from the resolution in hand and
 * the fold; nothing is resolved again.
 */
async function pack(fold: VaultFold, sender: LocalDidEntity, ends: Ends, plaintext: JsonObject, didcomm: DidcommApi): Promise<string> {
  const created = sender.created as NonNullable<LocalDidEntity["created"]>;
  const senderKid = ends.from + splitDidUrl(sender.methodIds.keyAgreement[0] as string)[1];
  const recipientKid = (plaintext.to as string[])[0] + splitDidUrl(ends.methodId)[1];
  const secrets = secretsOf(ends.senderKeys, [created.longFormDid, created.did], sender.methodIds);
  const resolver = pinnedResolver(fold, { current: [ends.resolution] });
  const [packed] = await packEncrypted(didcomm, plaintext as unknown as IMessage, recipientKid, senderKid, null, resolver, secretsResolverFor(secrets), { forward: false });
  return packed;
}
