/**
 * What an application is shown of the vault: messages, channels,
 * contacts, invitations and the work left for manual action, each a
 * plain JSON value read off one fold, so that a host can hand it over
 * a process boundary as it is. A record decides nothing and keeps no
 * authority: a message stays in the channel it was observed or sent
 * in, whichever contact shows it; what a peer claims of itself is
 * shown beside the exact channel it came by and names no contact; and
 * whatever is read from a body is gone with the body's erasure. The
 * manual step a record names is the one current evidence leaves open,
 * and the procedure behind it checks again under the lock.
 */

import { InvalidJson, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import {
  InvalidPlaintext,
  channelKey,
  compareChannels,
  readStoredDocument,
  unfinishedWork,
  type Channel,
  type ChannelView,
  type Cid,
  type ContactId,
  type ContactOrigin,
  type ContactView,
  type Did,
  type DidId,
  type DisclosureUses,
  type EpochSeconds,
  type EventId,
  type Execution,
  type ExecutionId,
  type ExecutionStatus,
  type InboundKind,
  type InvitationStatus,
  type Member,
  type MessageId,
  type MessageIn,
  type MessageOut,
  type Outbound,
  type Outcome,
  type ReadObject,
  type SendGate,
  type Status,
  type StoredAttachment,
  type VaultFold,
} from "@estoc/vault/v3";

import { PROFILE } from "../protocol/user-profile.js";
import { claimedName, reportedProblem } from "./handlers/index.js";

/** The manual procedures a record may name. */
export type ManualEntry = "eraseMessage" | "deleteContact" | "blockChannels" | "cancel" | "retry" | "completeResponse" | "completeNotification" | "rotate";

export interface MessageHeaders {
  type: string;
  thid: string | null;
  pthid: string | null;
  createdTime: EpochSeconds | null;
  expiresTime: EpochSeconds | null;
}

/** `missing` is content that is not here, is damaged, is too large to read or is no stored message document. */
export type BodyRecord = { state: "available"; body: JsonObject; attachments: StoredAttachment[] } | { state: "erased" } | { state: "missing" };

export type DiagnosticKind = "input" | "observations" | "receipt-integrity" | "intent" | "outcome" | "effect" | "work" | "remote-error";

export interface Diagnostic {
  kind: DiagnosticKind;
  because: string;
  /** for a remote error, the peer's report */
  report?: MessageId;
}

export interface MessageRecord {
  messageId: MessageId;
  direction: "in" | "out";
  channel: Channel;
  /** the undeleted contacts that select exactly this channel */
  contactIds: ContactId[];
  /** when this vault first recorded the message */
  at: string;
  /** null while the authenticated observations of an input, or the intents of an output, do not agree on one */
  msg: MessageHeaders | null;
  body: BodyRecord;
  /** what an input is to the protocols the vault speaks; null for an output, and while the input's intent is not agreed on */
  kind: InboundKind | null;
  /** the operation an output was produced by; null for an input and for a send of the user's */
  effectType: string | null;
  /** an input's standing; null for an output */
  input: ExecutionStatus | null;
  /** an output's delivery; null for an input */
  outcome: Outcome | null;
  acknowledged: boolean;
  late: boolean;
  /** an input's continuity proof, or the rotation decision an output announces */
  verification: Status;
  /** `retry` calls transport for an output again; `complete` gives an input a reply it still earns */
  manualAction: "retry" | "complete" | "none";
  /** the replies `complete` would give */
  completes: string[];
  diagnostics: Diagnostic[];
}

export interface ChannelRecord {
  channel: Channel;
  head: Channel | null;
  superseded: boolean;
  blocked: boolean;
  conflicted: boolean;
  send: SendGate;
  /** the name the peer last claimed in exactly this channel, and the input that claimed it */
  peerName: { name: string; messageId: MessageId } | null;
  /** the last profile of ours a transport accepted in exactly this channel */
  profileSubmitted: MessageId | null;
  messages: MessageRecord[];
}

export interface ContactChannelRecord extends ChannelRecord {
  /** selected by the contact; otherwise history reached from a selected channel over verified continuity */
  selected: boolean;
}

export interface ContactRecord {
  /** the contacts shown together; one with no origin has no creation here */
  contacts: { contactId: ContactId; origin: ContactOrigin | null; deleted: boolean; petname: string | null }[];
  /** the one petname the undeleted contacts give; null while none, or while they differ */
  petname: string | null;
  /** each flag the undeleted contacts do not disagree on */
  flags: Record<string, boolean>;
  channels: ContactChannelRecord[];
  writeTo: Channel[];
  defaultWriteTo: Channel | null;
  preference: { didId: DidId; matches: Channel[] } | null;
  diagnostics: string[];
}

export interface InvitationRecord {
  disclosureEventId: EventId;
  oobId: string;
  didId: DidId;
  localDid: Did | null;
  uses: DisclosureUses;
  state: InvitationStatus;
  consumer: Did | null;
}

export interface OpenOutbound {
  messageId: MessageId;
  channel: Channel | null;
  outcome: "queued" | "prepared";
  /** what no retry gets the message past; null while a retry may work on it */
  because: string | null;
  entries: ManualEntry[];
}

export interface OwedResponse {
  executionId: ExecutionId;
  messageId: MessageId;
  effectType: string;
  channel: Channel;
  /** none while the input's receipt is in an integrity conflict */
  entries: ManualEntry[];
}

export interface OwedNotification {
  rotationEventId: EventId;
  channel: Channel;
  sourceEventId: EventId | null;
  entries: ManualEntry[];
}

/** No entry: no retry may select among the intents that name one decision, and each of them shows the conflict as its outcome. */
export interface ConflictingNotification {
  rotationEventId: EventId;
  messageIds: MessageId[];
  entries: ManualEntry[];
}

/** No entry: a proof waits for issuer material only a repair or an import brings. */
export interface WaitingProof {
  sourceEventId: EventId;
  messageId: MessageId;
  channel: Channel | null;
  entries: ManualEntry[];
}

export interface PendingWork {
  pendingOutbounds: OpenOutbound[];
  missingResponses: OwedResponse[];
  missingNotifications: OwedNotification[];
  notificationConflicts: ConflictingNotification[];
  pendingProofs: WaitingProof[];
}

/** Reads of one fold's records share what they derive from it. */
export interface Recorder {
  /** every pair an input was observed in or an output is fixed to, in canonical order: a channel no contact selects is still shown */
  channels(): Channel[];
  /** the undeleted contacts, in ID order */
  contactIds(): ContactId[];
  channel(channel: Channel): Promise<ChannelRecord>;
  contact(...contactIds: readonly ContactId[]): Promise<ContactRecord>;
  invitations(): InvitationRecord[];
  pending(): PendingWork;
}

export function recorder(fold: VaultFold, readObject: ReadObject): Recorder {
  const work = unfinishedWork(fold);
  const completes = new Map<MessageId, string[]>();
  for (const { execution, effectType } of work.responses) completes.set(execution.messageId, [...(completes.get(execution.messageId) ?? []), effectType]);
  const context: Context = { fold, readObject, completes, documents: new Map(), reports: null };
  const channels = new Map<string, Promise<ChannelRecord>>();
  const channel = (pair: Channel): Promise<ChannelRecord> => {
    const key = channelKey(pair);
    let record = channels.get(key);
    if (record === undefined) channels.set(key, (record = channelRecord(context, fold.views.channel(pair))));
    return record;
  };
  return {
    channels: () => {
      const pairs = new Map<string, Channel>();
      for (const execution of fold.inbound.executions.values()) pairs.set(channelKey(execution.channel), execution.channel);
      for (const outbound of fold.outbound.outbounds.values()) if (outbound.channel !== null) pairs.set(channelKey(outbound.channel), outbound.channel);
      return [...pairs.values()].sort(compareChannels);
    },
    contactIds: () => [...fold.contacts.contacts.values()].filter((contact) => !contact.deleted).map((contact) => contact.contactId).sort(),
    channel,
    contact: async (...contactIds) => {
      const view = fold.views.contact(...contactIds);
      const records: ContactChannelRecord[] = [];
      for (const { channel: pair, selected } of view.channels) records.push({ ...(await channel(pair)), selected });
      return contactRecord(view, records);
    },
    invitations: () => invitationRecords(fold),
    pending: () => pendingWork(fold, work),
  };
}

interface Context {
  fold: VaultFold;
  readObject: ReadObject;
  completes: ReadonlyMap<MessageId, string[]>;
  documents: Map<Cid, Promise<BodyRecord>>;
  reports: Promise<ReadonlyMap<MessageId, Diagnostic[]>> | null;
}

function document(context: Context, erased: boolean, bodyCid: Cid): Promise<BodyRecord> {
  if (erased) return Promise.resolve({ state: "erased" });
  let read = context.documents.get(bodyCid);
  if (read === undefined) {
    read = context.readObject(bodyCid).then((bytes): BodyRecord => {
      if (bytes === null) return { state: "missing" };
      try {
        const { body, attachments } = readStoredDocument(parseStrict(bytes));
        return { state: "available", body, attachments };
      } catch (err) {
        if (err instanceof InvalidJson || err instanceof InvalidPlaintext) return { state: "missing" };
        throw err;
      }
    });
    context.documents.set(bodyCid, read);
  }
  return read;
}

const headersOf = (data: MessageIn | MessageOut): MessageHeaders => ({ type: data.msgType, thid: data.thid, pthid: data.pthid, createdTime: data.createdTime, expiresTime: data.expiresTime });

/**
 * The observation an input is shown by: its complete witness, else
 * the first whose proof counts, else the first. Its content is shown
 * when the observations whose proofs count agree on it, as the fold
 * reads the input's intent; while none counts yet, only when every
 * authenticated observation carries the same content.
 */
function shown(execution: Execution): { member: Member; agreed: boolean } {
  const member = execution.members.find((m) => m.witness.status === "complete") ?? execution.members.find((m) => m.positive) ?? execution.members[0]!;
  const intentHash = execution.intentHash ?? member.source.event.data.intentHash;
  const agreed = execution.status.status !== "conflict" && (execution.intentHash !== null || execution.members.every((m) => m.source.event.data.intentHash === intentHash));
  return { member, agreed };
}

const INTEGRITY = "one author gave the receipt's ordinal to another observation";

/** An output derived from a receipt in an integrity conflict takes no manual step. */
function integrityHeld(fold: VaultFold, outbound: Outbound): boolean {
  if (outbound.intent.status !== "consistent" || outbound.intent.data.sourceEventId === null) return false;
  const source = fold.channels.sources.get(outbound.intent.data.sourceEventId);
  return source !== undefined && fold.channels.receipts.affected.has(source.event.data.messageId);
}

/**
 * Each peer's readable problem report, under the output its thread
 * names: one in the report's own channel, or in a channel the report's
 * carrier may answer for over verified continuity, so the report is
 * looked for across the vault and shown where the output is.
 */
async function remoteErrors(context: Context): Promise<ReadonlyMap<MessageId, Diagnostic[]>> {
  const { fold } = context;
  const reports = new Map<MessageId, Diagnostic[]>();
  const executions = [...fold.inbound.executions.values()].filter((execution) => execution.kind === "error" && execution.status.status === "complete");
  for (const execution of executions.sort((a, b) => (a.messageId < b.messageId ? -1 : 1))) {
    const { source } = shown(execution).member;
    const outbound = fold.outbound.inReplyTo(source.event.eventId);
    if (outbound === null) continue;
    const body = await document(context, execution.erased, source.event.data.bodyCid);
    if (body.state !== "available") continue;
    reports.set(outbound.messageId, [...(reports.get(outbound.messageId) ?? []), { kind: "remote-error", because: reportedProblem(body.body), report: execution.messageId }]);
  }
  return reports;
}

async function channelRecord(context: Context, view: ChannelView): Promise<ChannelRecord> {
  const { fold } = context;
  const contactIds = fold.contacts.selecting(view.channel).map((contact) => contact.contactId);
  const reports = await (context.reports ??= remoteErrors(context));
  const messages: MessageRecord[] = [];
  let peerName: ChannelRecord["peerName"] = null;
  for (const execution of view.inbound) {
    const record = await inboundRecord(context, execution, contactIds);
    messages.push(record);
    if (execution.status.status !== "complete" || record.msg?.type !== PROFILE || record.body.state !== "available") continue;
    const name = claimedName(record.body.body);
    if (name !== null) peerName = { name, messageId: execution.messageId };
  }
  let profileSubmitted: MessageId | null = null;
  for (const outbound of view.outbound) {
    messages.push(await outboundRecord(context, outbound, view.channel, contactIds, reports.get(outbound.messageId) ?? []));
    if (outbound.intent.status === "consistent" && outbound.intent.data.msgType === PROFILE && outbound.submitted && !outbound.erased) profileSubmitted = outbound.messageId;
  }
  messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const { channel, head, superseded, blocked, conflicted, send } = view;
  return { channel, head, superseded, blocked, conflicted, send, peerName, profileSubmitted, messages };
}

async function inboundRecord(context: Context, execution: Execution, contactIds: ContactId[]): Promise<MessageRecord> {
  const { fold } = context;
  const { member, agreed } = shown(execution);
  const { data } = member.source.event;
  const diagnostics: Diagnostic[] = [];
  if (execution.status.status !== "complete") diagnostics.push({ kind: "input", because: execution.status.because });
  if (execution.siblings.length > 0) diagnostics.push({ kind: "observations", because: `${execution.siblings.length} observations claiming this input are not authenticated` });
  const integrity = fold.channels.receipts.affected.has(execution.messageId);
  if (integrity) diagnostics.push({ kind: "receipt-integrity", because: INTEGRITY });
  const completes = integrity ? [] : (context.completes.get(execution.messageId) ?? []);
  return {
    messageId: execution.messageId,
    direction: "in",
    channel: execution.channel,
    contactIds,
    at: execution.members.reduce((at, m) => (m.source.event.at < at ? m.source.event.at : at), member.source.event.at),
    msg: agreed ? headersOf(data) : null,
    body: agreed ? await document(context, execution.erased, data.bodyCid) : execution.erased ? { state: "erased" } : { state: "missing" },
    kind: execution.kind,
    effectType: null,
    input: execution.status,
    outcome: null,
    acknowledged: false,
    late: false,
    verification: fold.continuity.status(member.source.event.eventId),
    manualAction: completes.length > 0 ? "complete" : "none",
    completes,
    diagnostics,
  };
}

async function outboundRecord(context: Context, outbound: Outbound, channel: Channel, contactIds: ContactId[], reports: Diagnostic[]): Promise<MessageRecord> {
  const { fold } = context;
  const intent = outbound.intent.status === "consistent" ? outbound.intent.data : null;
  const diagnostics: Diagnostic[] = [];
  if (outbound.intent.status === "conflict") diagnostics.push({ kind: "intent", because: outbound.intent.because });
  else if (outbound.outcome.status === "conflict") diagnostics.push({ kind: "outcome", because: outbound.outcome.because });
  if (outbound.effect.status !== "complete" && diagnostics[0]?.because !== outbound.effect.because) diagnostics.push({ kind: "effect", because: outbound.effect.because });
  const open = outbound.outcome.status === "queued" || outbound.outcome.status === "prepared";
  if (open && outbound.work.kind === "none") diagnostics.push({ kind: "work", because: outbound.work.because });

  const held = integrityHeld(fold, outbound);
  if (held) diagnostics.push({ kind: "receipt-integrity", because: INTEGRITY });
  diagnostics.push(...reports);
  const rotationEventId = intent?.rotationEventId ?? null;
  return {
    messageId: outbound.messageId,
    direction: "out",
    channel,
    contactIds,
    at: outbound.intents.reduce((at, event) => (event.at < at ? event.at : at), outbound.intents[0]!.at),
    msg: intent === null ? null : headersOf(intent),
    body: intent === null ? (outbound.erased ? { state: "erased" } : { state: "missing" }) : await document(context, outbound.erased, intent.bodyCid),
    kind: null,
    effectType: intent?.effectType ?? null,
    input: null,
    outcome: outbound.outcome,
    acknowledged: outbound.acknowledged,
    late: outbound.late,
    verification: rotationEventId === null ? { status: "not-present" } : fold.continuity.status(rotationEventId),
    manualAction: open && outbound.work.kind !== "none" && !outbound.erased && !held ? "retry" : "none",
    completes: [],
    diagnostics,
  };
}

/**
 * Several contacts shown as one keep the petname they agree on, and a
 * flag only while none of them says otherwise.
 */
function contactRecord(view: ContactView, channels: ContactChannelRecord[]): ContactRecord {
  const shownContacts = view.contacts.filter((contact) => !contact.deleted);
  const petnames = new Set(shownContacts.flatMap((contact) => (contact.petname === null ? [] : [contact.petname])));
  const flags: Record<string, boolean> = {};
  const disputed = new Set<string>();
  for (const contact of shownContacts) {
    for (const [flag, value] of contact.flags) {
      if (flag in flags && flags[flag] !== value) disputed.add(flag);
      flags[flag] = value;
    }
  }
  for (const flag of disputed) delete flags[flag];

  const diagnostics: string[] = [];
  for (const contact of view.contacts) {
    if (contact.deleted) diagnostics.push(`the contact ${contact.contactId} is deleted`);
    else if (contact.origin === null) diagnostics.push(`no creation of the contact ${contact.contactId} is here`);
  }
  if (petnames.size > 1) diagnostics.push("the contacts shown together have different petnames");
  for (const record of channels) {
    if (!record.selected) continue;
    if (record.head === null) diagnostics.push(`no unique head follows the channel ${record.channel.localDid} ⇄ ${record.channel.peerDid}`);
    if (record.conflicted) diagnostics.push(`the continuity of the channel ${record.channel.localDid} ⇄ ${record.channel.peerDid} is in conflict`);
  }
  if (view.preference !== null && view.preference.matches.length === 0) diagnostics.push("the preferred local DID leads to no channel that takes a send now");
  if (view.writeTo.length > 1 && view.defaultWriteTo === null) diagnostics.push("several channels take a send: one must be chosen");

  return {
    contacts: view.contacts.map(({ contactId, origin, deleted, petname }) => ({ contactId, origin, deleted, petname })),
    petname: petnames.size === 1 ? [...petnames][0]! : null,
    flags,
    channels,
    writeTo: [...view.writeTo],
    defaultWriteTo: view.defaultWriteTo,
    preference: view.preference === null ? null : { didId: view.preference.didId, matches: [...view.preference.matches] },
    diagnostics,
  };
}

function invitationRecords(fold: VaultFold): InvitationRecord[] {
  return [...fold.invitations.invitations].map(([disclosureEventId, invitation]) => ({
    disclosureEventId,
    oobId: invitation.oobId,
    didId: invitation.didId,
    localDid: invitation.localDid,
    uses: invitation.disclosure.data.uses,
    state: invitation.status,
    consumer: invitation.consumer,
  }));
}

function pendingWork(fold: VaultFold, work: ReturnType<typeof unfinishedWork>): PendingWork {
  return {
    pendingOutbounds: work.outbounds.map((outbound) => {
      const because = outbound.work.kind === "none" ? outbound.work.because : integrityHeld(fold, outbound) ? INTEGRITY : null;
      return { messageId: outbound.messageId, channel: outbound.channel, outcome: outbound.outcome.status as "queued" | "prepared", because, entries: because === null ? ["retry", "cancel"] : ["cancel"] };
    }),
    missingResponses: work.responses.map(({ execution, effectType, channel }) => ({
      executionId: execution.id,
      messageId: execution.messageId,
      effectType,
      channel,
      entries: fold.channels.receipts.affected.has(execution.messageId) ? [] : ["completeResponse"],
    })),
    missingNotifications: work.notifications.map(({ decision, channel, source }) => ({ rotationEventId: decision.event.eventId, channel, sourceEventId: source?.event.eventId ?? null, entries: ["completeNotification"] })),
    notificationConflicts: work.notificationConflicts.map(({ decision, notification }) => ({ rotationEventId: decision.event.eventId, messageIds: [...notification.messageIds], entries: [] })),
    pendingProofs: work.proofs.map(({ source }) => ({ sourceEventId: source.event.eventId, messageId: source.event.data.messageId, channel: source.channel, entries: [] })),
  };
}
