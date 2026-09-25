/**
 * A local rotation: one of our DIDs replaced toward one peer by a
 * successor, decided under the writer lock and frozen as one record —
 * the predecessor, the canonical peer, the successor, the input that
 * selected it or none, and the proof the predecessor's authentication
 * key signs — committed atomically with the successor's creation, so
 * that a crash leaves both or neither and never a DID allocated for
 * nothing. A pair rotates once: the decision already recorded from
 * the predecessor anywhere in its verified peer-only context is
 * reused, and no second successor is minted while one waits for
 * evidence or two contradict each other. The peer must have written
 * to exactly the predecessor address, since a link from an address
 * the peer never used confirms nothing. A successor is a fresh entity,
 * or one recorded earlier; either way the decision is folded with the
 * evidence here before it is written, and refused when that fold puts
 * it or its context in conflict: the continuity graph keeps every
 * branch and chooses no winner, so a cycle the producer could see
 * coming would leave the whole context without authority for good.
 * The notification announcing the rotation is the decision's own
 * operation, made right after the decision commits under the same
 * lock and called under an initial action once the lock is released.
 * A decision found already recorded makes none: its missing
 * notification, left by a crash between the two commits, is manual
 * work, made only by an explicit completion while the input that
 * selected it still permits one.
 */

import { v7 as uuidv7 } from "uuid";

import { eventCidOf, type Event, type EventEnvelope, type Held, type VaultRuntime } from "@estoc/event-store";
import {
  EMPTY_MESSAGE_TYPE,
  ROTATION_NOTIFICATION_EFFECT,
  VaultEventSet,
  automaticIntent,
  canonicalDidOf,
  channelKey,
  channelOf,
  channelPolicy,
  checkVault,
  decisionFor,
  foldVault,
  kindOf,
  mintDid,
  notificationChannel,
  objectReader,
  readVaultEvent,
  sameChannel,
  scanVault,
  signFromPrior,
  vaultDraft,
  type Channel,
  type ScopedConflict,
  type Did,
  type DidId,
  type EventCid,
  type EventReference,
  type ExecutionId,
  type Keys,
  type LocalDidEntity,
  type MessageId,
  type MintedDid,
  type RouteId,
  type VaultDraft,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault";

import { LiveAction } from "./action.js";
import { didOf, mediatedRouteOf, routeTargetOf } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { dispatched, refused, type Drafted, type EffectOutcome } from "./effects.js";
import { EntityConflict, NotificationConflict, UnknownEntity, Unusable } from "./errors.js";
import { automaticDraft, manualNotificationDraft, type EffectContent } from "./send.js";
import type { AgentTrace } from "./trace.js";

/** The pair to rotate away from: one of our DID entities and the peer, in any spelling; and the live application input that selected the rotation, none for a manual one. */
export interface RotationTarget {
  localDidId: DidId;
  peerDid: string;
  sourceEventCid?: EventReference<"message.in"> | null;
}

export interface RotateOptions {
  /** the successor's route; when left out, the preferred arrangement's usable route, or with none the predecessor's */
  routeId?: RouteId;
  /** the successor's entity ID, for a rotation repeated after a lost result; a fresh UUIDv7 when left out */
  didId?: DidId;
  /** the clock the proof's issue time is read from, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
  /** a notification that could not be recorded or called goes to the `diag` stream */
  trace?: AgentTrace;
  /** the one transport call of the notification under its action: the dispatcher's */
  dispatch: (action: LiveAction) => Promise<Dispatched>;
}

export interface Rotated {
  decision: VaultEvent<"did.rotationSelected">;
  /** the pair rotated away from, canonical */
  channel: Channel;
  successor: DidId;
  /** the decision was recorded already: reused as it is, no successor minted, and its notification left to a completion */
  existed: boolean;
  notification: EffectOutcome;
}

/** A decision already recorded is returned with the state of its notification, nothing written or called. */
export async function rotate(runtime: VaultRuntime, keys: Keys, target: RotationTarget, options: RotateOptions): Promise<Rotated> {
  const decided = await runtime.locked(async (held) => {
    let fold = await scanVault(held, keys);
    const predecessor = didOf(fold, target.localDidId);
    if (predecessor.created === null || predecessor.conflict) throw new Unusable("DID", predecessor.didId, predecessor.faults);
    const peerDid = canonicalDidOf(target.peerDid) as Did;
    if (peerDid === predecessor.created.did) throw new Unusable("DID", predecessor.didId, ["the peer is the local DID itself"]);
    const channel = channelOf(predecessor.created.did, peerDid);
    const key = channelKey(channel);
    const sourceEventCid = target.sourceEventCid ?? null;
    const denied = channelPolicy(fold, channel, { automatic: sourceEventCid !== null });
    if (denied !== null) throw new Unusable("channel", key, [denied]);
    const existing = decisionFor(fold, channel.localDid, channel.peerDid);
    if (existing.status === "reuse") return { channel, decision: existing.decision.event, existed: true, drafted: recorded(fold, existing.decision.event.cid), executionId: null };
    if (existing.status !== "none") throw new Unusable("channel", key, [existing.because]);
    if (sourceEventCid !== null) assertSelectingSource(fold, channel, sourceEventCid);
    if (!fold.continuity.confirmed(channel.localDid, channel.peerDid)) throw new Unusable("channel", key, ["the peer has not written to exactly this address"]);

    const { drafts, successor } = await successorOf(fold, keys, predecessor, sourceEventCid !== null, options);
    const iat = Math.floor((options.now ?? Date.now)() / 1000);
    const fromPrior = await signFromPrior(keys, { didId: predecessor.didId, longFormDid: predecessor.created.longFormDid }, successor.longFormDid, iat);
    drafts.push(vaultDraft("did.rotationSelected", { fromDidId: predecessor.didId, peerDid: channel.peerDid, toDidId: successor.didId, sourceEventCid, fromPrior }));
    const refusal = await rotationRefusal(held, runtime, keys, fold, drafts);
    if (refusal !== null) throw new Unusable("DID", successor.didId, [refusal]);
    const events = (await held.commit([], drafts)).map(readVaultEvent);
    const decision = events[events.length - 1] as VaultEvent<"did.rotationSelected">;
    fold = await scanVault(held, keys);
    const settled = await settleNotification(held, fold, decision.cid as EventReference<"did.rotationSelected">, options.trace ?? null);
    const drafted: Drafted = settled.drafted.outcome === "created" ? { ...settled.drafted, action: new LiveAction(settled.drafted.messageId, "initial") } : settled.drafted;
    return { channel, decision, existed: false, drafted, executionId: settled.executionId };
  });
  const notification = await dispatched(decided.drafted, decided.executionId, options);
  return { decision: decided.decision, channel: decided.channel, successor: decided.decision.data.toDidId, existed: decided.existed, notification };
}

/**
 * The explicit completion of a decision's notification: the one
 * missing after a crash, made under the same decision, source and
 * successor while its channel still takes it; or the one recorded,
 * called again. Either goes under a manual action. Several intents
 * naming the decision are its conflict, which no completion resolves.
 */
export async function completeNotification(runtime: VaultRuntime, keys: Keys, rotationEventCid: EventReference<"did.rotationSelected">, options: RotateOptions): Promise<EffectOutcome> {
  const decided = await runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const settled = await settleNotification(held, fold, rotationEventCid, options.trace ?? null);
    const { drafted } = settled;
    return { ...settled, drafted: drafted.outcome === "created" || drafted.outcome === "existing" ? { ...drafted, action: new LiveAction(drafted.messageId, "manual") } : drafted };
  });
  return dispatched(decided.drafted, decided.executionId, options);
}

/** What the fold would refuse the recorded decision for is refused here first, so that no decision is committed to be refused. */
function assertSelectingSource(fold: VaultFold, channel: Channel, sourceEventCid: EventReference<"message.in">): void {
  const source = fold.channels.sources.get(sourceEventCid as EventCid);
  if (source === undefined) throw new UnknownEntity("input", sourceEventCid);
  const faults: string[] = [];
  if (source.channel === null || !sameChannel(source.channel, channel)) faults.push(`not in channel ${channelKey(channel)}`);
  const witness = fold.continuity.witness(source.event.cid);
  if (witness.status !== "complete") faults.push(`no complete witness: ${witness.because}`);
  const execution = fold.inbound.ofSource(source.event.cid);
  if (execution === null) faults.push("in no input here");
  else if (execution.status.status !== "complete") faults.push(`its input is not established: ${execution.status.because}`);
  const kind = kindOf(source.event.data);
  if (kind !== "application") faults.push(`a control input selects no rotation: it is ${kind}`);
  if (faults.length > 0) throw new Unusable("input", sourceEventCid, faults);
}

/**
 * The successor: minted from a fresh entity ID on the route given, or
 * the one new addresses go on, and created in the decision's own
 * commit. The route is chosen for the successor rather than handed
 * down: the usable route over the preferred arrangement where there
 * is one, so that an address leaves a mediator the vault has moved
 * away from, and the predecessor's otherwise. An entity already
 * recorded under the ID given keeps the route it was created on, and is the
 * successor of a manual rotation only, when the seed and the route
 * give exactly its document and it is live; a rotation an input
 * selected is the private-address policy's, whose successor is an
 * address no one has yet. What would differ is refused rather than
 * replaced.
 */
async function successorOf(fold: VaultFold, keys: Keys, predecessor: LocalDidEntity, selected: boolean, options: RotateOptions): Promise<{ drafts: VaultDraft[]; successor: MintedDid }> {
  const didId = options.didId ?? (uuidv7() as DidId);
  const existing = fold.routes.dids.get(didId);
  const preferred = fold.mediations.preferred === null ? null : mediatedRouteOf(fold, fold.mediations.preferred);
  const routeId = options.routeId ?? existing?.created?.boundRouteId ?? preferred?.routeId ?? predecessor.created!.boundRouteId;
  const successor = await mintDid(keys, didId, routeTargetOf(fold, routeId));
  if (existing === undefined) return { drafts: [vaultDraft("did.created", { didId, did: successor.did, longFormDid: successor.longFormDid, boundRouteId: routeId })], successor };
  const same = existing.created !== null && existing.created.did === successor.did && existing.created.longFormDid === successor.longFormDid && existing.created.boundRouteId === routeId;
  if (!same) throw new EntityConflict("DID", didId, existing.conflict ? existing.faults.join("; ") : "another document or route");
  const faults: string[] = [];
  if (selected) faults.push("a rotation an input selects takes a fresh successor");
  if (!existing.live) faults.push(...(existing.retired !== null ? [`retired: ${existing.retired}`, ...existing.faults] : existing.faults));
  if (faults.length > 0) throw new Unusable("DID", didId, faults);
  return { drafts: [], successor };
}

/**
 * Why the fold would refuse the decision once the drafts, the
 * decision last, are committed with the evidence here, or null: a
 * join it implies may confirm a decision still waiting, and a channel
 * no conflict reached before may be reached now. The candidates exist
 * only in this set; nothing is appended here.
 */
async function rotationRefusal(held: Held, runtime: VaultRuntime, keys: Keys, fold: VaultFold, drafts: readonly VaultDraft[]): Promise<string | null> {
  const at = new Date().toISOString();
  const candidates: Event[] = drafts.map((draft) => {
    const envelope: EventEnvelope = { at, author: runtime.author, type: draft.type, roots: draft.roots ?? [], data: draft.data };
    return { ...envelope, cid: eventCidOf(envelope) };
  });
  const set = VaultEventSet.of([...fold.set.all(), ...candidates]);
  const next = foldVault(set, await checkVault(set, keys, objectReader(held.objects)));
  const decisionId = candidates[candidates.length - 1]!.cid;
  const decision = next.channels.decisions.get(decisionId)!;
  if (decision.status.status === "invalid" || decision.status.status === "conflict") return `the decision would be ${decision.status.status}: ${decision.status.because}`;
  const continuity = next.continuity.status(decisionId);
  if (continuity.status === "conflict") return `the decision would be in conflict: ${continuity.because}`;
  const before = conflictedChannels(fold.continuity.conflicts);
  for (const [key, kind] of conflictedChannels(next.continuity.conflicts)) if (!before.has(key)) return `the decision would put ${key} in conflict: ${kind}`;
  return null;
}

function conflictedChannels(conflicts: readonly ScopedConflict[]): Map<string, ScopedConflict["conflict"]["kind"]> {
  const reached = new Map<string, ScopedConflict["conflict"]["kind"]>();
  for (const { conflict, channels } of conflicts) for (const channel of channels) reached.set(channelKey(channel), conflict.kind);
  return reached;
}

/** The state of a recorded decision's notification, for a rotation that reuses the decision: nothing is made or called for it here. */
function recorded(fold: VaultFold, rotationEventCid: EventCid): Drafted {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const notification = fold.outbound.notificationFor(rotationEventCid);
  if (notification.status === "selected") return { effectType, outcome: "existing", messageId: notification.messageId };
  if (notification.status === "conflict") return { effectType, outcome: "none", because: `${notification.messageIds.length} notification intents name the rotation` };
  return { effectType, outcome: "none", because: "the decision was recorded already: its missing notification is made by an explicit completion" };
}

/** The decision's one notification, reused as recorded or made now over the input that selected the decision, or over none under a fresh message ID. */
async function settleNotification(held: Held, fold: VaultFold, rotationEventCid: EventReference<"did.rotationSelected">, trace: AgentTrace | null): Promise<{ drafted: Drafted; executionId: ExecutionId | null }> {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const decision = fold.channels.decisions.get(rotationEventCid as EventCid);
  if (decision === undefined) throw new UnknownEntity("rotation", rotationEventCid);
  const notification = fold.outbound.notificationFor(decision.event.cid);
  if (notification.status === "conflict") throw new NotificationConflict(rotationEventCid, notification.messageIds);
  const executionId = decision.event.data.sourceEventCid === null ? null : (fold.inbound.ofSource(decision.event.data.sourceEventCid as EventCid)?.id ?? null);
  if (notification.status === "selected") return { drafted: { effectType, outcome: "existing", messageId: notification.messageId }, executionId };
  const selected = notificationChannel(fold, decision);
  if (selected.status === "none") return { drafted: { effectType, outcome: "none", because: selected.because }, executionId };
  const { channel, source } = selected;
  const carried = source?.event.data ?? null;
  const content: EffectContent = { type: EMPTY_MESSAGE_TYPE, body: {}, thid: carried === null ? null : (carried.thid ?? carried.wireMessageId), pthid: carried?.pthid ?? null, createdTime: carried?.createdTime ?? null, expiresTime: null, pleaseAck: [""], ack: [] };
  const execution = executionId === null ? null : fold.inbound.executions.get(executionId)!;
  const messageId = execution === null ? (uuidv7() as MessageId) : automaticIntent(fold, execution, effectType).messageId;
  try {
    let objects;
    let draft;
    if (source === null || execution === null) ({ draft, objects } = manualNotificationDraft(fold, messageId, channel, content, rotationEventCid));
    else {
      const automatic = automaticDraft(fold, { execution, source, effectType, channel, rotationEventCid }, content);
      if (automatic.existing !== null) return { drafted: { effectType, outcome: "none", because: "the intent under the input's tuple names another rotation" }, executionId };
      ({ draft, objects } = automatic);
    }
    const [event] = (await held.commit(objects, [draft])).map(readVaultEvent);
    return { drafted: { effectType, outcome: "created", messageId, intent: event as VaultEvent<"message.out"> }, executionId };
  } catch (err) {
    return { drafted: await refused(effectType, messageId, executionId, err, trace), executionId };
  }
}
