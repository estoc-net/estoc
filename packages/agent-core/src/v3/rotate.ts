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
 * or one recorded earlier that no replacement path leads back from:
 * the continuity graph keeps every branch and chooses no winner, so a
 * cycle the producer could see coming would leave the whole context
 * without authority for good.
 * The notification announcing the rotation is the decision's own
 * operation, made right after the decision commits under the same
 * lock and called under an initial action once the lock is released.
 * A decision found already recorded makes none: its missing
 * notification, left by a crash between the two commits, is manual
 * work, made only by an explicit completion while the input that
 * selected it still permits one.
 */

import { v7 as uuidv7 } from "uuid";

import type { Held, VaultRuntime } from "@estoc/event-store/v3";
import {
  EMPTY_MESSAGE_TYPE,
  ROTATION_NOTIFICATION_EFFECT,
  automaticIntent,
  canonicalDidOf,
  channelKey,
  channelOf,
  channelPolicy,
  decisionFor,
  kindOf,
  mintDid,
  notificationChannel,
  readVaultEvent,
  sameChannel,
  scanVault,
  signFromPrior,
  vaultDraft,
  type Channel,
  type Did,
  type DidId,
  type EventId,
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
} from "@estoc/vault/v3";

import { LiveAction } from "./action.js";
import { didOf, routeTargetOf } from "./dids.js";
import type { Dispatched } from "./dispatch.js";
import { dispatched, refused, type Drafted, type EffectOutcome } from "./effects.js";
import { EntityConflict, NotificationConflict, UnknownEntity, Unusable } from "./errors.js";
import { automaticDraft, manualNotificationDraft, type EffectContent } from "./send.js";
import type { AgentTrace } from "./trace.js";

/** The pair to rotate away from: one of our DID entities and the peer, in any spelling; and the live application input that selected the rotation, none for a manual one. */
export interface RotationTarget {
  localDidId: DidId;
  peerDid: string;
  sourceEventId?: EventReference<"message.in"> | null;
}

export interface RotateOptions {
  /** the successor's route; the predecessor's when left out */
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
    const sourceEventId = target.sourceEventId ?? null;
    const denied = channelPolicy(fold, channel, { automatic: sourceEventId !== null });
    if (denied !== null) throw new Unusable("channel", key, [denied]);
    const existing = decisionFor(fold, channel.localDid, channel.peerDid);
    if (existing.status === "reuse") return { channel, decision: existing.decision.event, existed: true, drafted: recorded(fold, existing.decision.event.eventId), executionId: null };
    if (existing.status !== "none") throw new Unusable("channel", key, [existing.because]);
    if (sourceEventId !== null) assertSelectingSource(fold, channel, sourceEventId);
    if (!fold.continuity.confirmed(channel.localDid, channel.peerDid)) throw new Unusable("channel", key, ["the peer has not written to exactly this address"]);

    const { drafts, successor } = await successorOf(fold, keys, predecessor, channel, sourceEventId !== null, options);
    const iat = Math.floor((options.now ?? Date.now)() / 1000);
    const fromPrior = await signFromPrior(keys, { didId: predecessor.didId, longFormDid: predecessor.created.longFormDid }, successor.longFormDid, iat);
    const events = (await held.commit([], [...drafts, vaultDraft("did.rotationSelected", { fromDidId: predecessor.didId, peerDid: channel.peerDid, toDidId: successor.didId, sourceEventId, fromPrior })])).map(readVaultEvent);
    const decision = events[events.length - 1] as VaultEvent<"did.rotationSelected">;
    fold = await scanVault(held, keys);
    const settled = await settleNotification(held, fold, decision.eventId as EventReference<"did.rotationSelected">, options.trace ?? null);
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
export async function completeNotification(runtime: VaultRuntime, keys: Keys, rotationEventId: EventReference<"did.rotationSelected">, options: RotateOptions): Promise<EffectOutcome> {
  const decided = await runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const settled = await settleNotification(held, fold, rotationEventId, options.trace ?? null);
    const { drafted } = settled;
    return { ...settled, drafted: drafted.outcome === "created" || drafted.outcome === "existing" ? { ...drafted, action: new LiveAction(drafted.messageId, "manual") } : drafted };
  });
  return dispatched(decided.drafted, decided.executionId, options);
}

/** What the fold would refuse the recorded decision for is refused here first, so that no decision is committed to be refused. */
function assertSelectingSource(fold: VaultFold, channel: Channel, sourceEventId: EventReference<"message.in">): void {
  const source = fold.channels.sources.get(sourceEventId as EventId);
  if (source === undefined) throw new UnknownEntity("input", sourceEventId);
  const faults: string[] = [];
  if (source.channel === null || !sameChannel(source.channel, channel)) faults.push(`not in channel ${channelKey(channel)}`);
  const witness = fold.continuity.witness(source.event.eventId);
  if (witness.status !== "complete") faults.push(`no complete witness: ${witness.because}`);
  const execution = fold.inbound.ofSource(source.event.eventId);
  if (execution === null) faults.push("in no input here");
  else if (execution.status.status !== "complete") faults.push(`its input is not established: ${execution.status.because}`);
  const kind = kindOf(source.event.data);
  if (kind !== "application") faults.push(`a control input selects no rotation: it is ${kind}`);
  if (faults.length > 0) throw new Unusable("input", sourceEventId, faults);
}

/**
 * The successor: minted from a fresh entity ID on the predecessor's
 * route, or the route given, and created in the decision's own
 * commit. An entity already recorded under the ID given is the
 * successor of a manual rotation only, when the seed and the route
 * give exactly its document, it is live, and no replacement path
 * leads from it back to the predecessor; a rotation an input selected
 * is the private-address policy's, whose successor is an address no
 * one has yet. What would differ is refused rather than replaced.
 */
async function successorOf(fold: VaultFold, keys: Keys, predecessor: LocalDidEntity, channel: Channel, selected: boolean, options: RotateOptions): Promise<{ drafts: VaultDraft[]; successor: MintedDid }> {
  const didId = options.didId ?? (uuidv7() as DidId);
  const routeId = options.routeId ?? predecessor.created!.boundRouteId;
  const successor = await mintDid(keys, didId, routeTargetOf(fold, routeId));
  const existing = fold.routes.dids.get(didId);
  if (existing === undefined) return { drafts: [vaultDraft("did.created", { didId, did: successor.did, longFormDid: successor.longFormDid, boundRouteId: routeId })], successor };
  const same = existing.created !== null && existing.created.did === successor.did && existing.created.longFormDid === successor.longFormDid && existing.created.boundRouteId === routeId;
  if (!same) throw new EntityConflict("DID", didId, existing.conflict ? existing.faults.join("; ") : "another document or route");
  const faults: string[] = [];
  if (selected) faults.push("a rotation an input selects takes a fresh successor");
  if (!existing.live) faults.push(...(existing.retired !== null ? [`retired: ${existing.retired}`, ...existing.faults] : existing.faults));
  if (successor.did === channel.peerDid) faults.push("it is the peer's DID");
  if (leadsBack(fold, successor.did, channel.localDid)) faults.push("a replacement path from it leads back to the predecessor");
  if (faults.length > 0) throw new Unusable("DID", didId, faults);
  return { drafts: [], successor };
}

/** Does any replacement path in the positive graph, conflicted branches included, lead from a channel of `successor` to one of `predecessor`? */
function leadsBack(fold: VaultFold, successor: Did, predecessor: Did): boolean {
  const seen = new Set<string>();
  const queue = fold.continuity.links.filter((link) => link.from.localDid === successor).map((link) => link.from);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const key = channelKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    if (next.localDid === predecessor) return true;
    for (const link of fold.continuity.links) if (sameChannel(link.from, next)) queue.push(link.to);
  }
  return false;
}

/** The state of a recorded decision's notification, for a rotation that reuses the decision: nothing is made or called for it here. */
function recorded(fold: VaultFold, rotationEventId: EventId): Drafted {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const notification = fold.outbound.notificationFor(rotationEventId);
  if (notification.status === "selected") return { effectType, outcome: "existing", messageId: notification.messageId };
  if (notification.status === "conflict") return { effectType, outcome: "none", because: `${notification.messageIds.length} notification intents name the rotation` };
  return { effectType, outcome: "none", because: "the decision was recorded already: its missing notification is made by an explicit completion" };
}

/** The decision's one notification, reused as recorded or made now over the input that selected the decision, or over none under a fresh message ID. */
async function settleNotification(held: Held, fold: VaultFold, rotationEventId: EventReference<"did.rotationSelected">, trace: AgentTrace | null): Promise<{ drafted: Drafted; executionId: ExecutionId | null }> {
  const effectType = ROTATION_NOTIFICATION_EFFECT;
  const decision = fold.channels.decisions.get(rotationEventId as EventId);
  if (decision === undefined) throw new UnknownEntity("rotation", rotationEventId);
  const notification = fold.outbound.notificationFor(decision.event.eventId);
  if (notification.status === "conflict") throw new NotificationConflict(rotationEventId, notification.messageIds);
  const executionId = decision.event.data.sourceEventId === null ? null : (fold.inbound.ofSource(decision.event.data.sourceEventId as EventId)?.id ?? null);
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
    if (source === null || execution === null) ({ draft, objects } = manualNotificationDraft(fold, messageId, channel, content, rotationEventId));
    else {
      const automatic = automaticDraft(fold, { execution, source, effectType, channel, rotationEventId }, content);
      if (automatic.existing !== null) return { drafted: { effectType, outcome: "none", because: "the intent under the input's tuple names another rotation" }, executionId };
      ({ draft, objects } = automatic);
    }
    const [event] = (await held.commit(objects, [draft])).map(readVaultEvent);
    return { drafted: { effectType, outcome: "created", messageId, intent: event as VaultEvent<"message.out"> }, executionId };
  } catch (err) {
    return { drafted: await refused(effectType, messageId, executionId, err, trace), executionId };
  }
}
