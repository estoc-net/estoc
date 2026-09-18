/**
 * The inbound observations as logical inputs. Every authenticated
 * observation whose own authentication is complete belongs to the
 * input its canonical sender, recipient and wire ID name, and that
 * input has one execution in its channel; the observations of one
 * input agree on its intent or contradict it, and contradiction is
 * for good. What each observation is worth is the continuity fold's
 * verdict on it, its witness: an input is established once one
 * observation is a complete witness, and an observation whose
 * authentication or proof is incomplete or refused neither supplies an
 * input of its own nor withdraws what a complete one established. An
 * anonymous observation is in no channel and has no execution. The
 * fold reads inputs; what an input has produced, or is still owed, is
 * the outbound fold's question.
 */

import { storeMessage } from "../document.js";
import { executionId } from "../ids.js";
import type { Channel, EventId, ExecutionId, MessageHash, MessageId, MessageIn, WireMessageId } from "../types.js";
import { compareReceiptKeys, receiptOrderKey, type ChannelEvidence, type ReceiptKey, type Source } from "./channels.js";
import type { Continuity, Witness } from "./continuity.js";
import type { Erasures } from "./held.js";

export const EMPTY_MESSAGE_TYPE = "https://didcomm.org/empty/1.0/empty";
export const PING_RESPONSE_TYPE = "https://didcomm.org/trust-ping/2.0/ping-response";
export const PROBLEM_REPORT_TYPE = "https://didcomm.org/report-problem/2.0/problem-report";

/** The stored content of a message with body `{}` and no attachments. */
export const EMPTY_CONTENT_CID = storeMessage({}, []).bodyCid;

/**
 * What an observation is to the protocols the vault speaks. A pure ACK
 * is an Empty message with body `{}`, no attachments, targets in `ack`
 * and no ACK request of its own; any other Empty message — a rotation
 * notification, or a variant that is no pure ACK — is `empty`. A
 * ping-response and a problem report are read in the thread of what
 * they answer. None of the four is application input: they may
 * acknowledge, none of them starts an automatic reply. Everything
 * else is application input.
 */
export type InboundKind = "application" | "pure-ack" | "empty" | "ping-response" | "error";

export function kindOf(data: MessageIn): InboundKind {
  switch (data.msgType) {
    case EMPTY_MESSAGE_TYPE:
      return data.bodyCid === EMPTY_CONTENT_CID && data.attachmentCids.length === 0 && data.ack.length > 0 && data.pleaseAck === null ? "pure-ack" : "empty";
    case PING_RESPONSE_TYPE:
      return "ping-response";
    case PROBLEM_REPORT_TYPE:
      return "error";
    default:
      return "application";
  }
}

/** One observation of an input whose own authentication is complete, with what the continuity fold makes of it. */
export interface Member {
  readonly source: Source;
  /** its proof, if it brought one, supports a link: it counts toward the input's intent */
  readonly positive: boolean;
  readonly witness: Witness;
}

/**
 * Complete once one member is a complete witness and no two positive
 * members disagree on the intent. Conflict when they do, for good:
 * whatever later becomes of those members' witnesses, the input's
 * intent stays contradicted. Pending otherwise, with what the first
 * member still waiting for evidence waits for, or, when none waits,
 * why the first member is no complete witness.
 */
export type ExecutionStatus = { status: "complete" } | { status: "pending"; because: string } | { status: "conflict"; because: string };

export interface Execution {
  readonly id: ExecutionId;
  readonly messageId: MessageId;
  readonly channel: Channel;
  readonly wireMessageId: WireMessageId;
  /** the observations whose own authentication is complete, in first-receipt order */
  readonly members: readonly Member[];
  /** the observations claiming this input whose own authentication is incomplete or contradicted, in first-receipt order: listed, counted for nothing */
  readonly siblings: readonly Source[];
  /** the intent the positive members agree on; null while none is positive, or when they disagree */
  readonly intentHash: MessageHash | null;
  /** the kind of the agreed intent */
  readonly kind: InboundKind | null;
  readonly status: ExecutionStatus;
  /** the least receipt key among the complete witnesses of a complete input: the order ACK targets are frozen in */
  readonly firstReceiptKey: ReceiptKey | null;
  /** an erasure names the message: its content produces no new work */
  readonly erased: boolean;
}

export interface InboundFold {
  /** every input one complete authentication places in a channel, by its execution */
  readonly executions: ReadonlyMap<ExecutionId, Execution>;
  /** the anonymous observations, in first-receipt order */
  readonly anonymous: readonly Source[];
  /** the authenticated observations no execution places: their own authentication is incomplete or contradicted, and so is every sibling's */
  readonly unplaced: readonly Source[];
  ofMessage(messageId: MessageId): Execution | null;
  /** the execution of the input an observation claims, whether it is a member or a sibling of it */
  ofSource(sourceEventId: EventId): Execution | null;
}

export function foldInbound(evidence: ChannelEvidence, continuity: Continuity, erasures: Erasures): InboundFold {
  const anonymous: Source[] = [];
  const members = new Map<MessageId, Source[]>();
  const siblings = new Map<MessageId, Source[]>();
  for (const source of evidence.sources.values()) {
    const { data } = source.event;
    if (data.peerResolutionEventId === null) anonymous.push(source);
    else {
      const group = source.standing.status === "complete" ? members : siblings;
      const list = group.get(data.messageId);
      if (list === undefined) group.set(data.messageId, [source]);
      else list.push(source);
    }
  }

  const byMessage = new Map<MessageId, Execution>();
  const executions = new Map<ExecutionId, Execution>();
  for (const [messageId, sources] of members) {
    const execution = executionOf(messageId, sources.sort(byReceipt), (siblings.get(messageId) ?? []).sort(byReceipt), evidence, continuity, erasures);
    byMessage.set(messageId, execution);
    executions.set(execution.id, execution);
  }
  const unplaced: Source[] = [];
  for (const [messageId, sources] of siblings) if (!members.has(messageId)) unplaced.push(...sources);
  return {
    executions,
    anonymous: anonymous.sort(byReceipt),
    unplaced: unplaced.sort(byReceipt),
    ofMessage: (messageId) => byMessage.get(messageId) ?? null,
    ofSource: (sourceEventId) => {
      const source = evidence.sources.get(sourceEventId);
      return source === undefined || source.event.data.peerResolutionEventId === null ? null : (byMessage.get(source.event.data.messageId) ?? null);
    },
  };
}

const byReceipt = (a: Source, b: Source) => compareReceiptKeys(receiptOrderKey(a.event), receiptOrderKey(b.event));

/**
 * One input from its complete observations. They share the message
 * ID, and a complete authentication has checked that ID against the
 * observation's own endpoints and wire ID, so they share the channel
 * and the wire ID too. The positive ones must agree on the intent;
 * the others carry a proof not yet verified or refused, and neither
 * establish a contradiction nor clear one.
 */
function executionOf(messageId: MessageId, sources: readonly Source[], siblings: readonly Source[], evidence: ChannelEvidence, continuity: Continuity, erasures: Erasures): Execution {
  const channel = sources[0]!.channel!;
  const wireMessageId = sources[0]!.event.data.wireMessageId;
  const members: Member[] = sources.map((source) => ({ source, positive: evidence.positive(source.event.eventId), witness: continuity.witness(source.event.eventId) }));
  const intents = new Set<MessageHash>();
  for (const member of members) if (member.positive) intents.add(member.source.event.data.intentHash);
  const complete = members.filter((member) => member.witness.status === "complete");
  const shared = { id: executionId(channel.peerDid, channel.localDid, wireMessageId), messageId, channel, wireMessageId, members, siblings, erased: erasures.has(messageId) };
  if (intents.size > 1) return { ...shared, intentHash: null, kind: null, status: { status: "conflict", because: `${intents.size} intents are authenticated for one input` }, firstReceiptKey: null };
  const intentHash = intents.size === 1 ? [...intents][0]! : null;
  const kind = intentHash === null ? null : kindOf(members.find((member) => member.positive)!.source.event.data);
  if (complete.length > 0) return { ...shared, intentHash, kind, status: { status: "complete" }, firstReceiptKey: receiptOrderKey(complete[0]!.source.event) };
  const waiting = (members.find((member) => member.witness.status === "pending") ?? members[0]!).witness as Exclude<Witness, { status: "complete" }>;
  return { ...shared, intentHash, kind, status: { status: "pending", because: `no observation is a complete witness: ${waiting.because}` }, firstReceiptKey: null };
}
