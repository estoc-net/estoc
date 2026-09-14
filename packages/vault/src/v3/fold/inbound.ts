/**
 * The inbound messages: every committed observation with the receipt
 * key its ordinal and author make, and the executions the observations
 * derive. An execution is one wire ID in one relationship, and is the
 * logical message: the observations of every group scoped there, at
 * whatever local key each arrived and under whatever peer key each was
 * authenticated, since a repack to another of our keys or a verified
 * rotation of the peer's changes neither the message nor its
 * execution. The execution's intent is proven by every observation
 * whose own row is scoped there, read from that row alone, and two
 * that disagree contradict the execution whatever their groups later
 * wait for or contradict, since a proven disagreement is not undone by
 * less evidence; short of that, one group complete in the relationship
 * completes the execution, one still waiting defers it, and groups
 * that all contradict make it a conflict. A complete execution is
 * classified from the intent its observations agree on and the proofs
 * they carry: application input, or one of the control observations —
 * a pure acknowledgment, an address notification carrying a proof a
 * transition validated, a response correlated to an outbound of the
 * relationship, a no-response error — or a control type that fails
 * its predicate, which is neither. Anonymous groups are messages of
 * their own, with no execution. Receipt keys order acknowledgment
 * targets: the least key of a logical message's observations, compared
 * by the exact integer ordinal and then the author, never by the
 * clock; two events of one author under one ordinal are a receipt
 * conflict that keeps their messages from being fresh targets and
 * changes nothing else. The next ordinal to allocate is one above every
 * ordinal here, whoever recorded it and whether or not the message was
 * since erased.
 */

import { canonicalize, compareEvents } from "@estoc/event-store/v3";

import { rawCidOfBytes } from "../document.js";
import { executionId as executionIdOf } from "../ids.js";
import { expandPleaseAck } from "../projection.js";
import type { VaultEvent } from "../schema.js";
import type { AuthorId, EventId, ExecutionId, MessageHash, MessageId, MessageIn, ReceiptOrdinal, RelationshipId, WireMessageId } from "../types.js";
import type { ObservationGroup, ObservationScope, RelationshipFold } from "./relationships.js";
import { groupBy, keyOf, type SourceKey, type VaultEventSet } from "./set.js";

/** What identifies a receipt: the exact integer ordinal, then the author. */
export type ReceiptKey = { readonly ordinal: ReceiptOrdinal; readonly author: AuthorId };

/** Canonical decimals without leading zeros compare as integers by length first. */
export function compareOrdinals(a: ReceiptOrdinal, b: ReceiptOrdinal): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

export function compareReceiptKeys(a: ReceiptKey, b: ReceiptKey): number {
  return compareOrdinals(a.ordinal, b.ordinal) || (a.author < b.author ? -1 : a.author > b.author ? 1 : 0);
}

/**
 * What a logical message is: application input, or a control
 * observation — a pure acknowledgment, an address notification whose
 * proof a transition validated, an Empty or ping response correlated
 * to an outbound of the relationship, a no-response error — or a
 * control type that fails its predicate, which is neither application
 * input nor executable.
 */
export type MessageKind = "application" | "pure-ack" | "notification" | "response" | "error" | "malformed-control";

/** The headers a logical message's observations agree on: what classifies and threads it. */
export type InboundIntent = Pick<MessageIn, "msgType" | "thid" | "pthid" | "pleaseAck" | "ack">;

export interface Observation {
  readonly eventId: EventId;
  readonly messageId: MessageId;
  readonly wireMessageId: WireMessageId;
  readonly receiptKey: ReceiptKey;
  readonly scope: ObservationScope;
  /** the execution the observation derives in the relationship its row names, null while none is named or the sender is anonymous */
  readonly executionId: ExecutionId | null;
  /** another event of the same author carries this ordinal */
  readonly receiptConflict: boolean;
}

export type ExecutionStatus = "complete" | "incomplete" | "conflict";

export interface Execution {
  readonly executionId: ExecutionId;
  readonly relationshipId: RelationshipId;
  readonly wireMessageId: WireMessageId;
  /** every observation message ID whose group derives this execution, by its own relationship or by a scoped row of its, sorted */
  readonly messageIds: readonly MessageId[];
  /** the observations of the complete groups, in canonical order: the logical message */
  readonly eventIds: readonly EventId[];
  /** the one intent every scoped row proves; null while no row is scoped, or while they disagree */
  readonly intentHash: MessageHash | null;
  readonly status: ExecutionStatus;
  /** why the execution is not complete, null while it is */
  readonly because: string | null;
  /** the headers of the logical message, null while the execution is not complete */
  readonly intent: InboundIntent | null;
  readonly kind: MessageKind | null;
  /** the least receipt key of the logical message's observations, null while the execution is not complete */
  readonly firstReceiptKey: ReceiptKey | null;
  /** the earliest observation of the logical message: where it stands in a thread; null while the execution is not complete */
  readonly sourceKey: SourceKey | null;
  /** an observation of the logical message is in a receipt conflict: not a fresh acknowledgment target */
  readonly receiptConflict: boolean;
}

/** The observations of one anonymous message ID: a message with no relationship and no execution. */
export interface AnonymousMessage {
  readonly messageId: MessageId;
  readonly wireMessageId: WireMessageId;
  readonly eventIds: readonly EventId[];
  /** null while the observations disagree on the intent */
  readonly intentHash: MessageHash | null;
  readonly intent: InboundIntent | null;
  readonly kind: MessageKind | null;
  readonly firstReceiptKey: ReceiptKey;
  readonly sourceKey: SourceKey;
  readonly receiptConflict: boolean;
}

export interface ReceiptConflict {
  readonly author: AuthorId;
  readonly ordinal: ReceiptOrdinal;
  readonly eventIds: readonly EventId[];
}

export interface InboundFold {
  readonly observations: ReadonlyMap<EventId, Observation>;
  readonly executions: ReadonlyMap<ExecutionId, Execution>;
  readonly anonymous: ReadonlyMap<MessageId, AnonymousMessage>;
  /** every observation message ID under its wire ID, sorted: for a group whose relationship is not yet known */
  readonly groupsByWire: ReadonlyMap<WireMessageId, readonly MessageId[]>;
  readonly receiptConflicts: readonly ReceiptConflict[];
  /** one above every ordinal here, whoever recorded it; `1` while none is */
  readonly nextReceiptOrdinal: ReceiptOrdinal;
}

type Receipt = VaultEvent<"message.in">;

const EMPTY = "https://didcomm.org/empty/1.0/empty";
const PING = "https://didcomm.org/trust-ping/2.0/ping";
const PING_RESPONSE = "https://didcomm.org/trust-ping/2.0/ping-response";
export const PROBLEM_REPORT = "https://didcomm.org/report-problem/2.0/problem-report";

/** The stored document of a message with an empty body and no attachments, as `bodyCid` names it. */
export const EMPTY_DOCUMENT_CID = rawCidOfBytes(canonicalize({ attachments: [], body: {} }));

export function foldInbound(set: VaultEventSet, relationships: RelationshipFold): InboundFold {
  const receipts = set.of("message.in");
  const byId = new Map<EventId, Receipt>(receipts.map((receipt) => [receipt.eventId, receipt]));

  const conflicted = new Set<EventId>();
  const receiptConflicts: ReceiptConflict[] = [];
  for (const [, events] of groupBy(receipts, (receipt) => `${receipt.author} ${receipt.data.receiptOrdinal}`)) {
    if (events.length < 2) continue;
    for (const event of events) conflicted.add(event.eventId);
    receiptConflicts.push({ author: events[0]!.author, ordinal: events[0]!.data.receiptOrdinal, eventIds: events.map((event) => event.eventId) });
  }
  receiptConflicts.sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : compareOrdinals(a.ordinal, b.ordinal)));

  const threads = threadsOf(set);
  const groupsByWire = new Map<WireMessageId, MessageId[]>();
  const drafts = new Map<ExecutionId, { relationshipId: RelationshipId; wireMessageId: WireMessageId; proven: MessageHash[]; messageIds: Set<MessageId> }>();
  const draftOf = (relationshipId: RelationshipId, wireMessageId: WireMessageId) => {
    const executionId = executionIdOf(relationshipId, wireMessageId);
    let draft = drafts.get(executionId);
    if (draft === undefined) drafts.set(executionId, (draft = { relationshipId, wireMessageId, proven: [], messageIds: new Set() }));
    return draft;
  };
  const observations = new Map<EventId, Observation>();
  for (const receipt of receipts) {
    const { messageId, wireMessageId, intentHash, receiptOrdinal } = receipt.data;
    const scope = relationships.observations.get(receipt.eventId)!;
    const relationshipId = scope.status === "anonymous" ? null : scope.relationshipId;
    if (scope.status === "scoped") {
      const draft = draftOf(scope.relationshipId, wireMessageId);
      draft.proven.push(intentHash);
      draft.messageIds.add(messageId);
    }
    observations.set(receipt.eventId, {
      eventId: receipt.eventId,
      messageId,
      wireMessageId,
      receiptKey: { ordinal: receiptOrdinal, author: receipt.author },
      scope,
      executionId: relationshipId === null ? null : executionIdOf(relationshipId, wireMessageId),
      receiptConflict: conflicted.has(receipt.eventId),
    });
  }
  const receiptsByMessage = groupBy(receipts, (receipt) => receipt.data.messageId);
  for (const [messageId, group] of relationships.groups) {
    const wireMessageId = receiptsByMessage.get(messageId)![0]!.data.wireMessageId;
    const wires = groupsByWire.get(wireMessageId);
    if (wires === undefined) groupsByWire.set(wireMessageId, [messageId]);
    else wires.push(messageId);
    if (group.status !== "anonymous" && group.relationshipId !== null) draftOf(group.relationshipId, wireMessageId).messageIds.add(messageId);
  }
  for (const wires of groupsByWire.values()) wires.sort();
  const wiresSorted = new Map([...groupsByWire].sort(([a], [b]) => (a < b ? -1 : 1)));

  const executions = new Map<ExecutionId, Execution>();
  for (const [executionId, draft] of [...drafts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const messageIds = [...draft.messageIds].sort();
    const groups = messageIds.map((messageId) => relationships.groups.get(messageId)!);
    const events = groups
      .flatMap((group) => (group.status === "complete" ? group.eventIds : []))
      .map((eventId) => byId.get(eventId)!)
      .sort(compareEvents);
    const intents = new Set(draft.proven);
    const { status, because } = statusOf(draft.proven.length, intents.size, groups);
    const complete = status === "complete";
    const scoped = (receipt: Receipt) => relationships.observations.get(receipt.eventId)!.status === "scoped";
    const proven = events.some((receipt) => scoped(receipt) && receipt.data.fromPrior !== null);
    executions.set(executionId, {
      executionId,
      relationshipId: draft.relationshipId,
      wireMessageId: draft.wireMessageId,
      messageIds,
      eventIds: events.map((receipt) => receipt.eventId),
      intentHash: intents.size === 1 ? draft.proven[0]! : null,
      status,
      because,
      intent: complete ? intentOf(events[0]!) : null,
      kind: complete ? kindOf(events[0]!.data, { scoped: true, proven, threads: threads.get(draft.relationshipId) }) : null,
      firstReceiptKey: complete ? leastKey(events) : null,
      sourceKey: complete ? keyOf(events[0]!) : null,
      receiptConflict: events.some((receipt) => conflicted.has(receipt.eventId)),
    });
  }

  const anonymous = new Map<MessageId, AnonymousMessage>();
  for (const [messageId, group] of [...relationships.groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.status !== "anonymous") continue;
    const events = group.eventIds.map((eventId) => byId.get(eventId)!);
    const agreed = events.every((receipt) => receipt.data.intentHash === events[0]!.data.intentHash);
    anonymous.set(messageId, {
      messageId,
      wireMessageId: events[0]!.data.wireMessageId,
      eventIds: group.eventIds,
      intentHash: agreed ? events[0]!.data.intentHash : null,
      intent: agreed ? intentOf(events[0]!) : null,
      kind: agreed ? kindOf(events[0]!.data, { scoped: false, proven: false, threads: undefined }) : null,
      firstReceiptKey: leastKey(events),
      sourceKey: keyOf(events[0]!),
      receiptConflict: events.some((receipt) => conflicted.has(receipt.eventId)),
    });
  }

  let greatest: ReceiptOrdinal | null = null;
  for (const receipt of receipts) if (greatest === null || compareOrdinals(receipt.data.receiptOrdinal, greatest) > 0) greatest = receipt.data.receiptOrdinal;
  return { observations, executions, anonymous, groupsByWire: wiresSorted, receiptConflicts, nextReceiptOrdinal: String(greatest === null ? 1n : BigInt(greatest) + 1n) as ReceiptOrdinal };
}

function statusOf(proven: number, intents: number, groups: readonly ObservationGroup[]): { status: ExecutionStatus; because: string | null } {
  if (intents > 1) return { status: "conflict", because: `is ${proven} scoped observations that disagree on the intent` };
  if (groups.some((group) => group.status === "complete")) return { status: "complete", because: null };
  if (groups.some((group) => group.status === "incomplete")) return { status: "incomplete", because: "awaits its evidence" };
  const conflict = groups.find((group) => group.status === "conflict") as { because: string };
  return { status: "conflict", because: `is in conflict: ${conflict.because}` };
}

const intentOf = ({ data }: Receipt): InboundIntent => ({ msgType: data.msgType, thid: data.thid, pthid: data.pthid, pleaseAck: data.pleaseAck, ack: data.ack });

function leastKey(events: readonly Receipt[]): ReceiptKey {
  let least: ReceiptKey | null = null;
  for (const receipt of events) {
    const key = { ordinal: receipt.data.receiptOrdinal, author: receipt.author };
    if (least === null || compareReceiptKeys(key, least) < 0) least = key;
  }
  return least!;
}

/** The threads each relationship's outbound messages open, by `thid` or, absent one, by the message's own wire ID, with the types of the messages that opened them. */
type Threads = ReadonlyMap<RelationshipId, ReadonlyMap<string, ReadonlySet<string>>>;

function threadsOf(set: VaultEventSet): Threads {
  const threads = new Map<RelationshipId, Map<string, Set<string>>>();
  for (const event of set.of("message.out")) {
    const { relationshipId, thid, messageId, msgType } = event.data;
    let opened = threads.get(relationshipId);
    if (opened === undefined) threads.set(relationshipId, (opened = new Map()));
    const key = thid ?? messageId;
    const types = opened.get(key);
    if (types === undefined) opened.set(key, new Set([msgType]));
    else types.add(msgType);
  }
  return threads;
}

/**
 * The kind of a logical message from its agreed headers, its stored
 * content's identity and its evidence: `scoped` when it has a
 * relationship, `proven` when an observation of it whose row is scoped
 * carries a proof, `threads` what its relationship's outbounds opened.
 * An Empty must have an empty body and no attachment; Empty and ping
 * responses need a thread an outbound opened, a ping response one a
 * ping opened; a no-response error carries neither proof nor request
 * for acknowledgment, names its parent thread and has a relationship.
 * A control type that satisfies no predicate is malformed control, not
 * application input.
 */
function kindOf(data: MessageIn, evidence: { scoped: boolean; proven: boolean; threads: ReadonlyMap<string, ReadonlySet<string>> | undefined }): MessageKind {
  const { msgType, thid, pthid, pleaseAck, ack, fromPrior, bodyCid, attachmentCids } = data;
  const empty = bodyCid === EMPTY_DOCUMENT_CID && attachmentCids.length === 0;
  const opened = thid === null ? undefined : evidence.threads?.get(thid);
  if (msgType === EMPTY) {
    if (!empty) return "malformed-control";
    if (evidence.proven) return "notification";
    if (ack.length > 0 && pleaseAck === null) return "pure-ack";
    return opened === undefined ? "malformed-control" : "response";
  }
  if (msgType === PING_RESPONSE) return opened?.has(PING) ? "response" : "malformed-control";
  if (msgType === PROBLEM_REPORT) return evidence.scoped && fromPrior === null && pleaseAck === null && pthid !== null ? "error" : "malformed-control";
  return "application";
}

/**
 * The wire IDs a complete carrier may acknowledge: each ID its
 * `please_ack` requests, `""` standing for its own, that is a complete
 * execution in the carrier's own relationship and free of receipt
 * conflict, in first-receipt order. A wire ID another relationship
 * reuses is never one of them, and a carrier that is not complete, or
 * is malformed control, acknowledges nothing. Whether a usable sender
 * exists to answer with is the runtime's gate, not the fold's.
 */
export function ackTargets(inbound: InboundFold, carrier: Execution): WireMessageId[] {
  if (carrier.intent === null || carrier.intent.pleaseAck === null || carrier.kind === "malformed-control") return [];
  const targets: Execution[] = [];
  for (const wireMessageId of expandPleaseAck(carrier.wireMessageId, carrier.intent.pleaseAck)) {
    const target = inbound.executions.get(executionIdOf(carrier.relationshipId, wireMessageId as WireMessageId));
    if (target !== undefined && target.status === "complete" && !target.receiptConflict) targets.push(target);
  }
  return targets.sort((a, b) => compareReceiptKeys(a.firstReceiptKey!, b.firstReceiptKey!)).map((target) => target.wireMessageId);
}
