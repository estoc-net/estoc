/**
 * The receipt: an authenticated delivery recorded in the vault, or told
 * why it may not be. Everything is decided under the writer lock over
 * the fold read there, and the evidence goes in the order its references
 * need — the sender's resolution, the binding a new pair takes, then the
 * observation naming both by the event IDs those commits returned — each
 * its own commit, so that a crash between them leaves evidence to reuse
 * and nothing received. The relationship is found by the address pair,
 * never chosen by role: the one whose histories hold the recipient and
 * the sender, or, for a pair nothing holds or claims, one born at those
 * two addresses. A carried proof names its relationship by its issuer
 * and is checked against the snapshot that relationship pinned before
 * its carrier is recorded; the transition it proves is not recorded
 * here.
 */

import { v7 as uuidv7 } from "uuid";

import type { Held, VaultRuntime } from "@estoc/event-store/v3";
import {
  InvalidDidDocument,
  InvalidFromPrior,
  InvalidPayload,
  InvalidPlaintext,
  InvalidPublicKey,
  canonicalDidOf,
  fromPriorClaims,
  inboundMessageId,
  objectReader,
  readPlaintext,
  relationshipId as relationshipIdOf,
  samePayload,
  scanVault,
  sweepDeleted,
  vaultDraft,
  verifyFromPrior,
  type Cid,
  type DeliveryId,
  type Did,
  type DidId,
  type EventReference,
  type FromPriorClaims,
  type Keys,
  type MessageId,
  type MessageIn,
  type ReadPlaintext,
  type ReceiptOrdinal,
  type Relationship,
  type RelationshipId,
  type VaultEvent,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault/v3";

import { commitResolution, objectsHeld, pinnedResolution } from "../evidence.js";
import { pairEvidence, type AuthenticatedSender, type Dependency } from "./gate.js";
import type { Authenticated, Receipt, ReceiptOutcome } from "./receiver.js";

export interface ReceiptOptions {
  /** told when the cleanup a deleted contact's late input is owed did not finish; the next sweep finishes it */
  log?: (line: string) => void;
}

export function receiptOf(runtime: VaultRuntime, keys: Keys, options: ReceiptOptions = {}): Receipt {
  return (authenticated) => recordReceipt(runtime, keys, authenticated, options);
}

type Observed = Omit<MessageIn, "receiptOrdinal" | "peerResolutionEventId" | "relationshipBindingEventId" | "peerTransitionEventId">;

type Objects = { cid: Cid; source: Uint8Array }[];

interface Placement {
  relationshipId: RelationshipId;
  /** the binding the observation names; null for a pair born with this delivery */
  bindingEventId: EventReference<"relationship.bound"> | null;
  /** the applied transition that added a proof-free sender, null for the root or a carrier */
  transitionEventId: EventReference<"relationship.peerTransitioned"> | null;
  /** the sender is a peer address of the relationship that a later one has replaced */
  superseded: boolean;
  /** proof-free, at the binding's root local address and from its root peer: the only receipt that consumes an invitation */
  root: boolean;
}

type Settled = { outcome: ReceiptOutcome; tombstoned: boolean };

const RECEIVED: ReceiptOutcome = { outcome: "received" };

const terminal = (reason: string): ReceiptOutcome => ({ outcome: "terminal", reason });

/**
 * Record one authenticated delivery, or say why not: terminal when the
 * vault may never record it, waiting when evidence of its relationship
 * may yet place it, deferred when this runtime's own state is not ready.
 * Input that only repeats an observation whose objects are all here is
 * received without a second record. Input in a relationship assigned to
 * a deleted contact is recorded all the same, then cleaned up as the
 * deletion requires.
 */
export async function recordReceipt(runtime: VaultRuntime, keys: Keys, authenticated: Authenticated, options: ReceiptOptions = {}): Promise<ReceiptOutcome> {
  let read: ReadPlaintext;
  try {
    read = readPlaintext(authenticated.plaintext);
  } catch (err) {
    if (err instanceof InvalidPlaintext) return terminal(`the plaintext does not read: ${err.message}`);
    throw err;
  }
  if (read.fromPrior !== null && authenticated.sender === null) return terminal("the plaintext carries a from_prior, but no sender is authenticated");
  const observed = observationOf(authenticated, read);
  const refused = unrecordable(observed, authenticated.sender);
  if (refused !== null) return terminal(refused);
  const { stored } = read;
  const objects: Objects = [{ cid: stored.bodyCid, source: stored.bytes }, ...stored.payloads.map(({ cid, bytes }) => ({ cid, source: bytes }))];
  const { outcome, tombstoned } = await runtime.locked((held) => settle(held, keys, authenticated, observed, objects, stored.roots));
  if (tombstoned) {
    try {
      await sweepDeleted(runtime, keys);
    } catch (err) {
      options.log?.(`a deleted contact's late input was recorded but not cleaned up: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return outcome;
}

function observationOf({ recipient, sender, delivery }: Authenticated, read: ReadPlaintext): Observed {
  const { intent, stored } = read;
  const wireMessageId = intent.id as WireMessageId;
  const { source } = delivery;
  return {
    messageId: inboundMessageId(sender === null ? { localKeyName: recipient.localKeyName } : sender.peerPublicKey, wireMessageId),
    wireMessageId,
    intentHash: read.intentHash,
    plaintextHash: read.plaintextHash,
    localKeyName: recipient.localKeyName,
    msgType: intent.type,
    presentedDid: sender?.resolution.presentedDid ?? null,
    did: sender?.resolution.did ?? null,
    thid: intent.thid,
    pthid: intent.pthid,
    createdTime: intent.createdTime,
    expiresTime: intent.expiresTime,
    pleaseAck: intent.pleaseAck,
    ack: intent.ack,
    headers: intent.headers,
    fromPrior: read.fromPrior,
    bodyCid: stored.bodyCid,
    attachmentCids: stored.attachmentCids,
    bytes: stored.bytes.length,
    signedBy: sender?.signedBy ?? null,
    receivedVia: source.kind === "pickup" ? { mediationId: source.mediationId, deliveryId: source.deliveryId as DeliveryId } : { mediationId: null, deliveryId: null },
  };
}

/**
 * Why the vault would refuse the observation, asked before anything is
 * committed: input refused at its last commit must not leave a
 * resolution or a binding behind it. The event references are not known
 * yet; placeholders of their kind stand in, since only which of them
 * are present is checked.
 */
function unrecordable(observed: Observed, sender: AuthenticatedSender | null): string | null {
  const reference = uuidv7();
  try {
    vaultDraft("message.in", {
      ...observed,
      receiptOrdinal: "1" as ReceiptOrdinal,
      peerResolutionEventId: sender === null ? null : (reference as EventReference<"peer.resolved">),
      relationshipBindingEventId: sender === null ? null : (reference as EventReference<"relationship.bound">),
      peerTransitionEventId: null,
    });
    return null;
  } catch (err) {
    if (err instanceof InvalidPayload) return `the message does not record: ${err.message}`;
    throw err;
  }
}

async function settle(held: Held, keys: Keys, { recipient, sender }: Authenticated, observed: Observed, objects: Objects, roots: readonly Cid[]): Promise<Settled> {
  const fold = await scanVault(held, keys);
  const ends = (outcome: ReceiptOutcome): Settled => ({ outcome, tombstoned: false });
  switch (fold.routes.receipt(recipient.didId, fold.relationships.retainedDidIds)) {
    case "terminal":
      return ends(terminal(`${recipient.did} may no longer receive`));
    case "pending":
      return ends({ outcome: "deferred", reason: `${recipient.did} may not receive yet: ${fold.routes.dids.get(recipient.didId)?.faults.join("; ")}` });
  }
  const ordinal = fold.inbound.nextReceiptOrdinal;
  if (sender === null) {
    await observe(held, fold, objects, roots, { ...observed, receiptOrdinal: ordinal, peerResolutionEventId: null, relationshipBindingEventId: null, peerTransitionEventId: null });
    return ends(RECEIVED);
  }
  const placed = observed.fromPrior === null ? placeProofFree(fold, recipient, sender) : await placeCarrier(held, fold, recipient, sender, observed.fromPrior);
  if ("outcome" in placed) return ends(placed);
  const { relationshipId } = placed;
  if (placed.superseded && !observedIn(fold, observed.messageId, relationshipId)) {
    return ends(terminal(`${sender.resolution.did} is a peer address ${relationshipId} has moved on from, and ${observed.messageId} was not received there before`));
  }
  const invitation = invitationGate(fold, recipient, sender.resolution.did, placed, observed.pthid);
  if (invitation !== null) return ends(invitation);
  const resolution = await commitResolution(held, { resolution: sender.resolution, localKeyName: recipient.localKeyName, peerPublicKey: sender.peerPublicKey });
  const bindingEventId = placed.bindingEventId ?? (await bind(held, relationshipId, recipient.didId, resolution));
  await observe(held, fold, objects, roots, {
    ...observed,
    receiptOrdinal: ordinal,
    peerResolutionEventId: resolution.eventId as EventReference<"peer.resolved">,
    relationshipBindingEventId: bindingEventId,
    peerTransitionEventId: placed.transitionEventId,
  });
  return { outcome: RECEIVED, tombstoned: assignedToDeleted(fold, relationshipId) };
}

/**
 * A proof-free delivery's place, by its address pair. The one
 * relationship holding the pair in its histories is the place. Two
 * holding it contradict each other, and neither may take it. Where none
 * does, the pair is new only when nothing retained claims it: a claim
 * whose evidence is not all here — a carrier, a transition not yet
 * applied, an observation at the pair that is not scoped — may still
 * be settled, and the delivery waits for that rather than being born
 * beside it; a transition in conflict there never will be, and a
 * binding of the pair that contradicts itself never stands. Only then
 * is the pair born with this delivery — unless the local address is
 * retired, which takes no new relationship.
 */
function placeProofFree(fold: VaultFold, recipient: Authenticated["recipient"], sender: AuthenticatedSender): Placement | ReceiptOutcome {
  const localDid = recipient.did;
  const peerDid = sender.resolution.did;
  const pair = `${localDid} / ${peerDid}`;
  const waits = (reason: string): ReceiptOutcome => ({ outcome: "wait", reason, dependencies: [{ kind: "pair", localDid, peerDid }] });
  const { claimants, contradicted, awaited, born } = pairEvidence(fold, localDid, peerDid);
  if (claimants.length > 1) return terminal(`the pair ${pair} is in the histories of ${claimants.join(", ")}`);
  if (claimants.length === 1) return inHistories(fold, fold.relationships.relationships.get(claimants[0] as RelationshipId) as Relationship, recipient.didId, peerDid, true);

  if (contradicted.length > 0) return terminal(`the pair ${pair} is claimed by ${contradicted.join("; ")}`);
  if (awaited.length > 0) return waits(`the pair ${pair} awaits ${awaited.join("; ")}`);

  if (localDid === peerDid) return terminal(`the sender ${peerDid} is the recipient`);
  if (born !== null && born.bindingEventIds.length > 0) {
    return born.deferred.length > 0 ? waits(`the binding of ${born.relationshipId} awaits: ${born.deferred.join("; ")}`) : terminal(`the binding of ${born.relationshipId} does not stand: ${born.faults.join("; ")}`);
  }
  if (fold.routes.dids.get(recipient.didId)?.retired != null) return terminal(`${localDid} is retired and takes no new relationship`);
  return { relationshipId: relationshipIdOf(localDid, peerDid), bindingEventId: null, transitionEventId: null, superseded: false, root: true };
}

/**
 * A carrier's place, by its proof's issuer: the one relationship whose
 * histories hold the recipient and the issuer, checked before the
 * carrier is recorded — the proof verified against the snapshot that
 * relationship pinned for the issuer, and naming this sender, under the
 * spelling it presented, as the successor. No such relationship, or its
 * snapshot not here, supplies nothing to check the proof against: the
 * carrier waits for evidence at the issuer's pair, its proof not thereby
 * invalid. A proof the snapshot refutes is terminal, and so is one that
 * would continue into a pair another relationship already holds.
 */
async function placeCarrier(held: Held, fold: VaultFold, recipient: Authenticated["recipient"], sender: AuthenticatedSender, fromPrior: string): Promise<Placement | ReceiptOutcome> {
  const localDid = recipient.did;
  const peerDid = sender.resolution.did;
  let claims: FromPriorClaims;
  let issuer: Did;
  try {
    claims = fromPriorClaims(fromPrior);
    issuer = canonicalDidOf(claims.iss);
  } catch (err) {
    if (err instanceof InvalidFromPrior || err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return terminal(`the from_prior does not read: ${err.message}`);
    throw err;
  }
  if (claims.sub !== sender.resolution.presentedDid) return terminal(`the from_prior names ${claims.sub} as the successor, not the sender ${sender.resolution.presentedDid}`);
  const issuerPair = `${localDid} / ${issuer}`;
  const dependencies: Dependency[] = [
    { kind: "pair", localDid, peerDid: issuer },
    { kind: "pair", localDid, peerDid },
  ];
  const claimants = fold.relationships.claimants(localDid, issuer);
  if (claimants.length !== 1) {
    const holding = claimants.length === 0 ? "no relationship holds" : `${claimants.join(", ")} all hold`;
    return { outcome: "wait", reason: `${holding} the pair ${issuerPair} the from_prior continues`, dependencies };
  }
  const relationshipId = claimants[0] as RelationshipId;
  const pinned = await pinnedResolution(fold, objectReader(held.objects), relationshipId, issuer);
  if (pinned === null) return { outcome: "wait", reason: `the snapshot ${relationshipId} pinned for ${issuer} is not here`, dependencies };
  try {
    await verifyFromPrior(fromPrior, { did: pinned.did, document: pinned.document });
  } catch (err) {
    if (err instanceof InvalidFromPrior) return terminal(`the from_prior does not verify against the snapshot ${relationshipId} pinned for ${issuer}: ${err.message}`);
    throw err;
  }
  const others = fold.relationships.claimants(localDid, peerDid).filter((claimant) => claimant !== relationshipId);
  if (others.length > 0) return terminal(`the from_prior would continue ${relationshipId} into the pair ${localDid} / ${peerDid}, which ${others.join(", ")} already hold`);
  return inHistories(fold, fold.relationships.relationships.get(relationshipId) as Relationship, recipient.didId, peerDid, false);
}

/**
 * The place a relationship holding the recipient gives: the binding that
 * pinned its root document, and for a proof-free sender the transition
 * that added the sender's address. A sender behind the current peer end
 * is superseded there.
 */
function inHistories(fold: VaultFold, relationship: Relationship, localDidId: DidId, peerDid: Did, proofFree: boolean): Placement {
  const { peerChain } = relationship;
  const at = peerChain.findIndex((node) => node.did === peerDid);
  const root = peerChain[0];
  const pinning = relationship.bindingEventIds.find((eventId) => {
    const binding = fold.set.resolve(eventId, "relationship.bound");
    return binding.status === "present" && binding.event.data.peerResolutionEventId === root?.resolutionEventId;
  });
  const edge = proofFree && at > 0 ? peerChain[at]?.edgeEventIds[0] : undefined;
  return {
    relationshipId: relationship.relationshipId,
    bindingEventId: pinning ?? (relationship.bindingEventIds[0] as EventReference<"relationship.bound">),
    transitionEventId: (edge ?? null) as EventReference<"relationship.peerTransitioned"> | null,
    superseded: at >= 0 && at < peerChain.length - 1,
    root: proofFree && at === 0 && relationship.binding?.localDidId === localDidId,
  };
}

/** Whether an observation of this message ID was already recorded in the relationship: by the scope it stands in, or the binding it names. */
function observedIn(fold: VaultFold, messageId: MessageId, relationshipId: RelationshipId): boolean {
  return fold.set.of("message.in").some((event) => {
    if (event.data.messageId !== messageId) return false;
    const scope = fold.relationships.observations.get(event.eventId);
    if (scope !== undefined && scope.status !== "anonymous" && scope.relationshipId === relationshipId) return true;
    const binding = event.data.relationshipBindingEventId === null ? null : fold.set.resolve(event.data.relationshipBindingEventId, "relationship.bound");
    return binding?.status === "present" && binding.event.data.relationshipId === relationshipId;
  });
}

/**
 * A root-address receipt whose parent thread is one of the recipient's
 * invitations consumes it when committed, so the invitation decides
 * first: taken by another relationship or no longer open, the delivery
 * is terminal; while evidence still to arrive says who took it, the
 * delivery waits for that evidence, and for the evidence of its own
 * pair, which decides whether it is a root-address receipt at all.
 * Any other input with that thread ID takes nothing and is not stopped.
 */
function invitationGate(fold: VaultFold, recipient: Authenticated["recipient"], peerDid: Did, placed: Placement, pthid: string | null): ReceiptOutcome | null {
  if (!placed.root || pthid === null) return null;
  const invitation = fold.invitations.invitations.get(pthid);
  if (invitation === undefined || !invitation.disclosures.some((disclosure) => disclosure.data.didId === recipient.didId)) return null;
  const consumability = fold.invitations.consumable(pthid, placed.relationshipId);
  if (consumability === "unavailable") return terminal(`the invitation ${pthid} is not open to ${placed.relationshipId}`);
  if (consumability === "pending") {
    return {
      outcome: "wait",
      reason: `the invitation ${pthid} awaits evidence of who took it`,
      dependencies: [
        { kind: "invitation", oobId: pthid },
        { kind: "pair", localDid: recipient.did, peerDid },
      ],
    };
  }
  return null;
}

async function bind(held: Held, relationshipId: RelationshipId, localDidId: DidId, resolution: VaultEvent<"peer.resolved">): Promise<EventReference<"relationship.bound">> {
  const [bound] = await held.commit([], [vaultDraft("relationship.bound", { relationshipId, localDidId, peerResolutionEventId: resolution.eventId as EventReference<"peer.resolved"> })]);
  return (bound as { eventId: string }).eventId as EventReference<"relationship.bound">;
}

/** The observation committed with its objects, unless an equal one is recorded and its objects are all here: a delivery given again after a crash before its acknowledgement is not recorded twice. */
async function observe(held: Held, fold: VaultFold, objects: Objects, roots: readonly Cid[], data: MessageIn): Promise<void> {
  const recorded = fold.set.of("message.in").some((event) => event.data.messageId === data.messageId && samePayload({ ...event.data, receiptOrdinal: data.receiptOrdinal }, data));
  if (recorded && (await objectsHeld(held, roots))) return;
  await held.commit(objects, [vaultDraft("message.in", data)]);
}

function assignedToDeleted(fold: VaultFold, relationshipId: RelationshipId): boolean {
  return fold.set.of("relationship.contactAssigned").some((event) => event.data.relationshipId === relationshipId && fold.contacts.get(event.data.contactId)?.deleted === true);
}
