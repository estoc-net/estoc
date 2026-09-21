/**
 * An input's automatic effects: the outputs an established input earns
 * on its own, each the one intent of one operation over it, decided
 * under the writer lock over the fold read there and committed each on
 * its own. Each operation is its own boundary: one whose handler
 * throws, whose content makes no intent, whose record the disk refuses
 * or whose call's step throws leaves another's intent standing,
 * recorded and dispatched, so that the receipt an input requests never
 * waits on its protocol's reply.
 * Before any is decided, the input must be established by a complete
 * witness in a channel that takes a reply now: not denied, not in
 * conflict, its peer not moved on; and the reply's sender chosen by
 * the fold — the carrier's own local DID while it may send, else the
 * unique verified successor that keeps the peer — is fixed by the
 * intent for good. Each operation looks its tuple up first: an intent
 * already under it is reused as it is, before the input's body is
 * read or its handler asked anything, so that a fixed output survives
 * a body gone or a handler that would decide otherwise now, and the
 * same input delivered again, a package retried, a body erased or a
 * clock moved never make a second output. Two operations are the
 * vault's own — the receipt an input requests, given under local
 * policy to the targets the fold freezes in first-receipt order, and
 * the notification of a rotation, decided with the rotation — and the
 * rest are the protocols', each through its handler. An intent is
 * dispatched only under an action a live input minted, once the lock
 * is released; an input that is not live leaves its unfinished
 * outputs listed, and an explicit completion makes each of them under
 * the same tuple with a manual action.
 */

import { parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store";
import {
  EMPTY_MESSAGE_TYPE,
  PURE_ACK_EFFECT,
  objectReader,
  readStoredDocument,
  readVaultEvent,
  automaticIntent,
  responseChannel,
  scanVault,
  type EventReference,
  type Execution,
  type ExecutionId,
  type Keys,
  type MessageId,
  type Source,
  type VaultEvent,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault";

import { LiveAction, type LiveInput } from "./action.js";
import type { Dispatched } from "./dispatch.js";
import { UnknownEntity } from "./errors.js";
import { effectTypesOf, handlerFor, handlersOf, type Handler, type Input, type Response } from "./handlers/index.js";
import { MAX_CONTENT_BYTES } from "./prepare.js";
import { automaticDraft, type EffectContent } from "./send.js";
import { note, type AgentTrace } from "./trace.js";

export interface EffectOptions {
  /** the handlers registered beyond the built-in ones; one covering a built-in's type replaces it */
  handlers?: readonly Handler[];
  /** whether a requested receipt is given: local policy, on by default */
  acknowledge?: boolean;
  /** the clock a Ping's expiry is compared with, in milliseconds since the epoch; `Date.now` when left out */
  now?: () => number;
  /** an operation that threw, in deciding, recording or calling, goes to the `diag` stream */
  trace?: AgentTrace;
  /**
   * The one transport call of an intent under its action: the
   * dispatcher's, so that a prerequisite is waited out for as long as
   * the action lives. It is told the same handlers' effect types
   * (`effectTypesOf`), so that the fold it reads counts their intents
   * as this runtime's work.
   */
  dispatch: (action: LiveAction) => Promise<Dispatched>;
}

/** What the call of an intent came to; `threw` when the call's step threw, the action then telling whether the transport was called, and an acceptance it saw kept for the message's next work. */
export type Called = Dispatched | { outcome: "threw"; messageId: MessageId; reason: string };

export type EffectOutcome =
  /** a new intent, committed under the tuple and dispatched under the action minted for it */
  | { effectType: string; outcome: "created"; messageId: MessageId; intent: VaultEvent<"message.out">; action: LiveAction; dispatched: Called }
  /** the tuple had an intent already: reused as it is, dispatched only under a manual completion */
  | { effectType: string; outcome: "existing"; messageId: MessageId; action: LiveAction | null; dispatched: Called | null }
  /** the operation gives the input nothing now */
  | { effectType: string; outcome: "none"; because: string }
  /** the operation threw, in its handler deciding the content, in the content becoming an intent or in the disk recording it: nothing is committed for it, and the others stand */
  | { effectType: string; outcome: "refused"; because: string };

export interface Reacted {
  eventId: EventReference<"message.in">;
  /** null while the observation is in no established input: anonymous, or its input not yet established */
  executionId: ExecutionId | null;
  /** why no operation was asked: the observation is in no input here, or the input is not established */
  because: string | null;
  effects: EffectOutcome[];
}

/**
 * The effects of the input a live observation belongs to: every
 * operation decided under one lock, each new intent committed on its
 * own and then dispatched, in order, under the initial action the
 * input mints for it.
 */
export async function reactTo(runtime: VaultRuntime, keys: Keys, live: LiveInput, options: EffectOptions): Promise<Reacted> {
  const decided = await runtime.locked(async (held) => {
    const fold = await scan(held, keys, options);
    const execution = fold.inbound.ofSource(live.eventId);
    if (execution === null) return { executionId: null, because: "the observation is anonymous or in no input here", effects: [] };
    const settled = await settle(held, fold, execution, options);
    return { executionId: execution.id, because: settled.because, effects: settled.drafted.map((draft) => (draft.outcome === "created" ? { ...draft, action: live.mint(draft.messageId) } : draft)) };
  });
  const effects: EffectOutcome[] = [];
  for (const draft of decided.effects) effects.push(await dispatched(draft, decided.executionId, options));
  return { eventId: live.eventId, ...decided, effects };
}

/**
 * The explicit completion of one operation's output for an input that
 * is not live: an open found it unfinished, or its live effects were
 * never decided. The same checks and the same tuple as a live input's;
 * the intent, new or already recorded, is dispatched under a manual
 * action, which `created` and `existing` carry.
 */
export async function completeResponse(runtime: VaultRuntime, keys: Keys, executionId: ExecutionId, effectType: string, options: EffectOptions): Promise<EffectOutcome> {
  const decided = await runtime.locked(async (held): Promise<Drafted> => {
    const fold = await scan(held, keys, options);
    const execution = fold.inbound.executions.get(executionId);
    if (execution === undefined) throw new UnknownEntity("input", executionId);
    const settled = await settle(held, fold, execution, options, effectType);
    if (settled.because !== null) return { effectType, outcome: "none", because: settled.because };
    const draft = settled.drafted.find((draft) => draft.effectType === effectType);
    if (draft === undefined) return { effectType, outcome: "none", because: "no operation here gives the input this output" };
    if (draft.outcome === "none" || draft.outcome === "refused") return draft;
    return { ...draft, action: new LiveAction(draft.messageId, "manual") };
  });
  return dispatched(decided, executionId, options);
}

function scan(held: Held, keys: Keys, options: EffectOptions): Promise<VaultFold> {
  return scanVault(held, keys, { effectTypes: effectTypesOf(handlersOf(options.handlers)) });
}

/** An outcome before its dispatch: the action is minted by whoever decided the intent. */
export type Drafted =
  | { effectType: string; outcome: "created"; messageId: MessageId; intent: VaultEvent<"message.out">; action?: LiveAction }
  | { effectType: string; outcome: "existing"; messageId: MessageId; action?: LiveAction }
  | Extract<EffectOutcome, { outcome: "none" | "refused" }>;

/**
 * Under the lock: the input must be established, or no operation is
 * asked. The operations are the receipt and those the input's handler
 * declares, `only` narrowing them to one; each looks its tuple up
 * first, and only the ones with no intent yet are decided now — the
 * receipt by the vault, the rest by the handler, asked once for all of
 * them and answering with content for each it gives, one at most. A
 * handler that throws refuses every operation it was asked for; a
 * response that cannot be recorded refuses its own operation alone.
 */
async function settle(held: Held, fold: VaultFold, execution: Execution, options: EffectOptions, only?: string): Promise<{ because: string | null; drafted: Drafted[] }> {
  if (execution.status.status !== "complete") return { because: `the input is not established: ${execution.status.because}`, drafted: [] };
  const source = execution.members.find((member) => member.witness.status === "complete")!.source;
  const handler = handlerFor(handlersOf(options.handlers), source.event.data.msgType);
  const operations = [...new Set([PURE_ACK_EFFECT, ...(handler?.effectTypes ?? [])])].filter((effectType) => only === undefined || effectType === only);
  const trace = options.trace ?? null;
  const drafted = new Map<string, Drafted>();
  const open = new Map<string, MessageId>();
  for (const effectType of operations) {
    const tuple = automaticIntent(fold, execution, effectType);
    if (tuple.existing !== null) drafted.set(effectType, { effectType, outcome: "existing", messageId: tuple.messageId });
    else open.set(effectType, tuple.messageId);
  }
  const decide = async (response: Response): Promise<void> => {
    const messageId = open.get(response.effectType);
    if (messageId === undefined) return;
    drafted.set(response.effectType, await record(held, fold, execution, source, messageId, response, trace));
    open.delete(response.effectType);
  };
  if (open.has(PURE_ACK_EFFECT)) for (const response of acknowledgement(fold, source, options.acknowledge ?? true)) await decide(response);
  if (handler !== null && handler.effectTypes.some((effectType) => open.has(effectType))) {
    const input: Input = { execution, source, readBody: () => readBody(held, execution, source), now: options.now ?? Date.now };
    let responses: readonly Response[] = [];
    try {
      responses = await handler.respond(input, fold);
    } catch (err) {
      for (const effectType of handler.effectTypes) {
        const messageId = open.get(effectType);
        if (messageId !== undefined) drafted.set(effectType, await refused(effectType, messageId, execution.id, err, trace));
      }
    }
    for (const response of responses) await decide(response);
  }
  return { because: null, drafted: operations.flatMap((effectType) => drafted.get(effectType) ?? []) };
}

/**
 * The receipt the input requests, to the targets the fold freezes: an
 * Empty message on the carrier's thread with its creation time, naming
 * the targets and requesting nothing. A request that names no
 * eligible target is answered with nothing rather than an empty
 * receipt, since the array must name what it acknowledges.
 */
function acknowledgement(fold: VaultFold, source: Source, acknowledge: boolean): Response[] {
  const { data } = source.event;
  if (data.pleaseAck === null || data.pleaseAck.length === 0) return [];
  if (!acknowledge) return [{ effectType: PURE_ACK_EFFECT, content: null, because: "receipts are not given here" }];
  const targets: readonly WireMessageId[] = fold.outbound.ackTargets(source.event.eventId);
  if (targets.length === 0) return [{ effectType: PURE_ACK_EFFECT, content: null, because: "the request names no input of the channel that is established and unambiguous" }];
  const content: EffectContent = { type: EMPTY_MESSAGE_TYPE, body: {}, thid: data.thid ?? data.wireMessageId, pthid: data.pthid, createdTime: data.createdTime, expiresTime: null, pleaseAck: null, ack: targets };
  return [{ effectType: PURE_ACK_EFFECT, content }];
}

/** The channel and the record of one operation's output, once its tuple is known to hold no intent. */
async function record(held: Held, fold: VaultFold, execution: Execution, source: Source, messageId: MessageId, response: Response, trace: AgentTrace | null): Promise<Drafted> {
  const { effectType } = response;
  if (response.content === null) return { effectType, outcome: "none", because: response.because };
  try {
    const selected = responseChannel(fold, execution);
    if (selected.status === "none") return { effectType, outcome: "none", because: selected.because };
    const draft = automaticDraft(fold, { execution, source, effectType, channel: selected.channel }, response.content);
    const [event] = (await held.commit(draft.objects!, [draft.draft!])).map(readVaultEvent);
    return { effectType, outcome: "created", messageId, intent: event as VaultEvent<"message.out"> };
  } catch (err) {
    return refused(effectType, messageId, execution.id, err, trace);
  }
}

export async function refused(effectType: string, messageId: MessageId, executionId: ExecutionId | null, err: unknown, trace: AgentTrace | null): Promise<Drafted> {
  const because = messageOf(err);
  await note(trace, { stream: "diag", what: "effect", data: { messageId, executionId, effectType, reason: because } });
  return { effectType, outcome: "refused", because };
}

/** The stored body of the input, or null once the message is erased or the body cannot be read. */
async function readBody(held: Held, execution: Execution, source: Source): Promise<JsonObject | null> {
  if (execution.erased) return null;
  const bytes = await objectReader(held.objects, MAX_CONTENT_BYTES)(source.event.data.bodyCid);
  return bytes === null ? null : readStoredDocument(parseStrict(bytes)).body;
}

/** The one transport call of a drafted intent, under the action it carries; none for an intent no action was minted for. A call's step that throws is this operation's alone. */
export async function dispatched(draft: Drafted, executionId: ExecutionId | null, options: EffectOptions): Promise<EffectOutcome> {
  if (draft.outcome === "none" || draft.outcome === "refused") return draft;
  if (draft.action === undefined) return { ...draft, outcome: "existing", action: null, dispatched: null };
  const { action, messageId, effectType } = draft;
  try {
    return { ...draft, action, dispatched: await options.dispatch(action) };
  } catch (err) {
    const reason = messageOf(err);
    await note(options.trace ?? null, { stream: "diag", what: "effect", data: { messageId, executionId, effectType, reason } });
    return { ...draft, action, dispatched: { outcome: "threw", messageId, reason } };
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
