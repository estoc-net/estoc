/**
 * What an application is shown of the vault: messages, channels,
 * contacts, invitations and the work left for manual action, each a
 * plain JSON value read off one fold, so that a host can hand it over
 * a process boundary as it is. A record decides nothing and keeps no
 * authority: a message stays in the channel it was observed or sent
 * in, whichever contact shows it; what a peer claims of itself is
 * shown beside the exact channel it came by and names no contact; and
 * whatever is read from a body is gone with the body's erasure. An
 * input is shown by its admitted observations alone, as the runtime
 * reads it: what was received and not admitted — still pending,
 * refused, or ignored because the peer moved on — is listed apart,
 * with what the runtime made of it and nothing of what it carries.
 * The manual step a record names is the one current evidence leaves
 * open, and the procedure behind it checks again under the lock.
 */

import { InvalidJson, parseStrict, type JsonObject } from "@estoc/event-store";
import {
  InvalidDidDocument,
  InvalidPlaintext,
  PURE_ACK_EFFECT,
  automaticIntent,
  canonicalDidOf,
  channelKey,
  channelOf,
  compareChannels,
  compareReceiptKeys,
  readStoredDocument,
  receiptOrderKey,
  responseChannel,
  sameChannel,
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
  type EventCid,
  type Execution,
  type ExecutionId,
  type ExecutionStatus,
  type InboundKind,
  type InvitationStatus,
  type Member,
  type MessageId,
  type MessageIn,
  type MessageOut,
  type MissingResponse,
  type Outbound,
  type Outcome,
  type ReadObject,
  type SendGate,
  type Source,
  type Standing,
  type Status,
  type StoredAttachment,
  type VaultFold,
} from "@estoc/vault";

import { PROFILE } from "./protocol/user-profile.js";
import type { EffectOptions } from "./effects.js";
import { claimedName, handlerFor, handlersOf, reportedProblem, trustPing, type Handler } from "./handlers/index.js";

export type ViewOptions = Pick<EffectOptions, "handlers">;

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

export type DiagnosticKind = "input" | "observations" | "contradicting" | "receipt-integrity" | "intent" | "outcome" | "effect" | "work" | "remote-error";

export interface Diagnostic {
  kind: DiagnosticKind;
  because: string;
  /** for a remote error, the peer's report */
  report?: MessageId;
}

export interface MessageRecord {
  messageId: MessageId;
  direction: "in" | "out";
  /** null for an output no one pair is fixed for */
  channel: Channel | null;
  /** the undeleted contacts that select exactly this channel */
  contactIds: ContactId[];
  /** when this vault first recorded the message */
  at: string;
  /** null while the admitted observations of an input, or the intents of an output, do not agree on one */
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

/**
 * What the runtime made of one observation: admitted for application
 * use; refused for good; ignored because the peer has replaced its
 * DID and no admission of it stands; or still pending, with the
 * evidence it lacks or the blocker current policy holds against it.
 */
export type DispositionRecord = { status: "admitted" } | { status: "refused"; because: string } | { status: "ignored-superseded" } | { status: "pending-admission"; because: string };

/**
 * One observation as it was received, apart from the input it may be
 * shown by: how far its sender is authenticated, what became of a
 * proof it brought, and its disposition. Nothing it carries is shown
 * here; a content is read from an admitted observation, by the record
 * of its input.
 */
export interface ObservationRecord {
  sourceEventCid: EventCid;
  messageId: MessageId;
  /** the pair its endpoints form; null for an anonymous observation, while the local endpoint is unknown, and under contradicted evidence */
  channel: Channel | null;
  at: string;
  standing: Standing;
  verification: Status;
  disposition: DispositionRecord;
  /** it carries another content than the one its input has admitted */
  contradicting: boolean;
}

/** An output no one pair is fixed for, with the pairs its recorded intents would each fix. */
export interface UnplacedOutput {
  candidates: Channel[];
  message: MessageRecord;
}

export interface Unplaced {
  /** the observations whose pair is not known, in first-receipt order */
  inputs: ObservationRecord[];
  outputs: UnplacedOutput[];
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
  /** the last profile of ours a transport accepted in exactly this channel, whether or not its content is still here */
  profileSubmitted: MessageId | null;
  /** the inputs an admission names an observation of, with the outputs whose intents disagree while every one of them names this pair */
  messages: MessageRecord[];
  /** every observation of this pair, in first-receipt order, whether or not an input shows it */
  observations: ObservationRecord[];
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
  disclosureEventCid: EventCid;
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
  rotationEventCid: EventCid;
  channel: Channel;
  sourceEventCid: EventCid | null;
  entries: ManualEntry[];
}

/** No entry: no retry may select among the intents that name one decision, and each of them shows the conflict as its outcome. */
export interface ConflictingNotification {
  rotationEventCid: EventCid;
  messageIds: MessageId[];
  entries: ManualEntry[];
}

/** No entry: a proof waits for issuer material only a repair or an import brings. */
export interface WaitingProof {
  sourceEventCid: EventCid;
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
  /** every pair a channel record shows an observation or an output in, in canonical order, whether or not a contact selects it; the pairs an unplaced output's intents name are its candidates instead */
  channels(): Channel[];
  /** what no channel shows */
  unplaced(): Promise<Unplaced>;
  /** the undeleted contacts, in ID order */
  contactIds(): ContactId[];
  channel(channel: Channel): Promise<ChannelRecord>;
  contact(...contactIds: readonly ContactId[]): Promise<ContactRecord>;
  invitations(): InvitationRecord[];
  pending(): PendingWork;
}

/** `options.handlers` are the ones the runtime's completions run under: the replies their operations still owe are listed with the vault's own. */
export function recorder(fold: VaultFold, readObject: ReadObject, options: ViewOptions = {}): Recorder {
  const work = unfinishedWork(fold);
  const responses = owedResponses(fold, work.responses, handlersOf(options.handlers));
  const completes = new Map<MessageId, string[]>();
  for (const { execution, effectType } of responses) completes.set(execution.messageId, [...(completes.get(execution.messageId) ?? []), effectType]);

  const placed = new Map<string, Outbound[]>();
  const pairs = new Map<string, Channel>();
  const adrift: { outbound: Outbound; candidates: Channel[] }[] = [];
  for (const source of fold.channels.sources.values()) if (source.channel !== null) pairs.set(channelKey(source.channel), source.channel);
  for (const outbound of fold.outbound.outbounds.values()) {
    const { channel: pair, candidates } = placeOf(fold, outbound);
    if (pair === null) adrift.push({ outbound, candidates });
    else {
      pairs.set(channelKey(pair), pair);
      if (outbound.channel === null) placed.set(channelKey(pair), [...(placed.get(channelKey(pair)) ?? []), outbound]);
    }
  }

  const context: Context = { fold, readObject, completes, placed, documents: new Map(), reports: null };
  const channels = new Map<string, Promise<ChannelRecord>>();
  const channel = (pair: Channel): Promise<ChannelRecord> => {
    const key = channelKey(pair);
    let record = channels.get(key);
    if (record === undefined) channels.set(key, (record = channelRecord(context, fold.views.channel(pair))));
    return record;
  };
  return {
    channels: () => [...pairs.values()].sort(compareChannels),
    unplaced: async () => ({
      inputs: observationRecords(fold, [...fold.channels.sources.values()].filter((source) => source.channel === null)),
      outputs: await Promise.all(adrift.map(async ({ outbound, candidates }) => ({ candidates, message: await outboundRecord(context, outbound, null, [], []) }))),
    }),
    contactIds: () => [...fold.contacts.contacts.values()].filter((contact) => !contact.deleted).map((contact) => contact.contactId).sort(),
    channel,
    contact: async (...contactIds) => {
      const view = fold.views.contact(...contactIds);
      const records: ContactChannelRecord[] = [];
      for (const { channel: pair, selected } of view.channels) records.push({ ...(await channel(pair)), selected });
      return contactRecord(view, records);
    },
    invitations: () => invitationRecords(fold),
    pending: () => pendingWork(fold, work, responses),
  };
}

/**
 * The replies an established input may still be given. The receipt is
 * the vault's own candidate. A protocol's reply is a candidate under
 * each operation the input's handler declares and no intent records,
 * chosen as a completion chooses it, so that a registered handler
 * replacing a built-in one replaces its candidates too. An erased
 * input keeps the candidates of a registered handler, which may answer
 * from the headers alone and is shown no body by the completion; the
 * built-in Ping reply is decided by the body, so an erased Ping earns
 * none. Whether a candidate is given is the completion's call.
 */
function owedResponses(fold: VaultFold, own: readonly MissingResponse[], handlers: readonly Handler[]): MissingResponse[] {
  const owed = own.filter((response) => response.effectType === PURE_ACK_EFFECT);
  for (const execution of fold.inbound.executions.values()) {
    if (execution.firstWitness === null) continue;
    const { source } = execution.firstWitness;
    const handler = handlerFor(handlers, source.event.data.msgType);
    if (handler === null || (handler === trustPing && execution.erased)) continue;
    const operations = handler.effectTypes.filter((effectType) => effectType !== PURE_ACK_EFFECT && automaticIntent(fold, execution, effectType).existing === null);
    if (operations.length === 0) continue;
    const selected = responseChannel(fold, execution);
    if (selected.status === "none") continue;
    for (const effectType of new Set(operations)) owed.push({ execution, effectType, channel: selected.channel, source });
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return owed.sort((a, b) => order(a.execution.messageId, b.execution.messageId) || order(a.effectType, b.effectType));
}

/**
 * Where an output is shown: the pair its intent fixes, or, while its
 * intents disagree, the one pair every one of them names. No intent is
 * chosen over another: the pairs they would fix are only compared.
 */
function placeOf(fold: VaultFold, outbound: Outbound): { channel: Channel | null; candidates: Channel[] } {
  if (outbound.channel !== null) return { channel: outbound.channel, candidates: [outbound.channel] };
  const candidates = new Map<string, Channel>();
  let every = true;
  for (const { data } of outbound.intents) {
    const sender = fold.routes.dids.get(data.senderDidId);
    const local = sender === undefined || sender.conflict ? null : (sender.created?.did ?? null);
    const peer = canonicalOrNull(data.recipientDid);
    if (local === null || peer === null || local === peer) every = false;
    else candidates.set(channelKey(channelOf(local, peer)), channelOf(local, peer));
  }
  const pairs = [...candidates.values()].sort(compareChannels);
  return { channel: every && pairs.length === 1 ? pairs[0]! : null, candidates: pairs };
}

function canonicalOrNull(did: Did): Did | null {
  try {
    return canonicalDidOf(did);
  } catch (err) {
    if (err instanceof InvalidDidDocument) return null;
    throw err;
  }
}

function observationRecords(fold: VaultFold, sources: readonly Source[]): ObservationRecord[] {
  return sources
    .slice()
    .sort((a, b) => compareReceiptKeys(receiptOrderKey(a.event), receiptOrderKey(b.event)))
    .map(({ event, channel, standing }) => {
      const disposition = fold.dispositions.disposition(event.cid);
      return {
        sourceEventCid: event.cid,
        messageId: event.data.messageId,
        channel,
        at: event.at,
        standing,
        verification: fold.continuity.status(event.cid),
        disposition: disposition.status === "admitted" ? { status: "admitted" } : disposition,
        contradicting: fold.inbound.ofSource(event.cid)?.contradicting.some((member) => member.source.event.cid === event.cid) ?? false,
      };
    });
}

interface Context {
  fold: VaultFold;
  readObject: ReadObject;
  completes: ReadonlyMap<MessageId, string[]>;
  /** the outputs with no fixed pair that are shown in a channel, by its key */
  placed: ReadonlyMap<string, readonly Outbound[]>;
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

const shownBy = (execution: Execution): Member => execution.firstWitness ?? execution.members.find((member) => member.admitted)!;

const INTEGRITY = "one author gave the receipt's ordinal to another observation";

/** An output derived from a receipt in an integrity conflict takes no manual step. */
function integrityHeld(fold: VaultFold, outbound: Outbound): boolean {
  if (outbound.intent.status !== "consistent" || outbound.intent.data.sourceEventCid === null) return false;
  const source = fold.channels.sources.get(outbound.intent.data.sourceEventCid);
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
    const { source } = execution.firstWitness!;
    const outbound = fold.outbound.inReplyTo(source.event.cid);
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
    if (!execution.members.some((member) => member.admitted)) continue;
    const record = await inboundRecord(context, execution, contactIds);
    messages.push(record);
    if (execution.status.status !== "complete" || record.msg?.type !== PROFILE || record.body.state !== "available") continue;
    const name = claimedName(record.body.body);
    if (name !== null) peerName = { name, messageId: execution.messageId };
  }
  let profileSubmitted: MessageId | null = null;
  for (const outbound of [...view.outbound, ...(context.placed.get(channelKey(view.channel)) ?? [])]) {
    messages.push(await outboundRecord(context, outbound, view.channel, contactIds, reports.get(outbound.messageId) ?? []));
    if (outbound.intent.status === "consistent" && outbound.intent.data.msgType === PROFILE && outbound.submitted) profileSubmitted = outbound.messageId;
  }
  const observations = observationRecords(
    fold,
    [...fold.channels.sources.values()].filter((source) => source.channel !== null && sameChannel(source.channel, view.channel))
  );
  messages.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const { channel, head, superseded, blocked, conflicted, send } = view;
  return { channel, head, superseded, blocked, conflicted, send, peerName, profileSubmitted, messages, observations };
}

async function inboundRecord(context: Context, execution: Execution, contactIds: ContactId[]): Promise<MessageRecord> {
  const { fold } = context;
  const member = shownBy(execution);
  const agreed = execution.intentHash !== null;
  const { data } = member.source.event;
  const diagnostics: Diagnostic[] = [];
  if (execution.status.status !== "complete") diagnostics.push({ kind: "input", because: execution.status.because });
  if (execution.siblings.length > 0) diagnostics.push({ kind: "observations", because: `${execution.siblings.length} observations claiming this input are not authenticated` });
  if (execution.contradicting.length > 0) diagnostics.push({ kind: "contradicting", because: `${execution.contradicting.length} authenticated ${execution.contradicting.length === 1 ? "observation carries" : "observations carry"} another content than the one admitted` });
  const integrity = fold.channels.receipts.affected.has(execution.messageId);
  if (integrity) diagnostics.push({ kind: "receipt-integrity", because: INTEGRITY });
  const completes = integrity ? [] : (context.completes.get(execution.messageId) ?? []);
  return {
    messageId: execution.messageId,
    direction: "in",
    channel: execution.channel,
    contactIds,
    at: member.source.event.at,
    msg: agreed ? headersOf(data) : null,
    body: agreed ? await document(context, execution.erased, data.bodyCid) : execution.erased ? { state: "erased" } : { state: "missing" },
    kind: execution.kind,
    effectType: null,
    input: execution.status,
    outcome: null,
    acknowledged: false,
    late: false,
    verification: fold.continuity.status(member.source.event.cid),
    manualAction: completes.length > 0 ? "complete" : "none",
    completes,
    diagnostics,
  };
}

async function outboundRecord(context: Context, outbound: Outbound, channel: Channel | null, contactIds: ContactId[], reports: Diagnostic[]): Promise<MessageRecord> {
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
  const rotationEventCid = intent?.rotationEventCid ?? null;
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
    verification: rotationEventCid === null ? { status: "not-present" } : fold.continuity.status(rotationEventCid),
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
  const flags = new Map<string, boolean>();
  const disputed = new Set<string>();
  for (const contact of shownContacts) {
    for (const [flag, value] of contact.flags) {
      if (flags.has(flag) && flags.get(flag) !== value) disputed.add(flag);
      flags.set(flag, value);
    }
  }
  for (const flag of disputed) flags.delete(flag);

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
    flags: Object.fromEntries(flags),
    channels,
    writeTo: [...view.writeTo],
    defaultWriteTo: view.defaultWriteTo,
    preference: view.preference === null ? null : { didId: view.preference.didId, matches: [...view.preference.matches] },
    diagnostics,
  };
}

function invitationRecords(fold: VaultFold): InvitationRecord[] {
  return [...fold.invitations.invitations].map(([disclosureEventCid, invitation]) => ({
    disclosureEventCid,
    oobId: invitation.oobId,
    didId: invitation.didId,
    localDid: invitation.localDid,
    uses: invitation.disclosure.data.uses,
    state: invitation.status,
    consumer: invitation.consumer,
  }));
}

function pendingWork(fold: VaultFold, work: ReturnType<typeof unfinishedWork>, responses: readonly MissingResponse[]): PendingWork {
  return {
    pendingOutbounds: work.outbounds.map((outbound) => {
      const because = outbound.work.kind === "none" ? outbound.work.because : integrityHeld(fold, outbound) ? INTEGRITY : null;
      return { messageId: outbound.messageId, channel: outbound.channel, outcome: outbound.outcome.status as "queued" | "prepared", because, entries: because === null ? ["retry", "cancel"] : ["cancel"] };
    }),
    missingResponses: responses.map(({ execution, effectType, channel }) => ({
      executionId: execution.id,
      messageId: execution.messageId,
      effectType,
      channel,
      entries: fold.channels.receipts.affected.has(execution.messageId) ? [] : ["completeResponse"],
    })),
    missingNotifications: work.notifications.map(({ decision, channel, source }) => ({ rotationEventCid: decision.event.cid, channel, sourceEventCid: source?.event.cid ?? null, entries: ["completeNotification"] })),
    notificationConflicts: work.notificationConflicts.map(({ decision, notification }) => ({ rotationEventCid: decision.event.cid, messageIds: [...notification.messageIds], entries: [] })),
    pendingProofs: work.proofs.map(({ source }) => ({ sourceEventCid: source.event.cid, messageId: source.event.data.messageId, channel: source.channel, entries: [] })),
  };
}
