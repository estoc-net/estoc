import { describe, expect, it } from "vitest";

import type { DIDDoc } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store/v3";
import {
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_RESPONSE_TYPE,
  PING_TYPE,
  PURE_ACK_EFFECT,
  automaticMessageId,
  blockChannels,
  effectKey,
  eraseMessage,
  scanVault,
  signFromPrior,
  unfinishedWork,
  vaultDraft,
  type DidId,
  type EventReference,
  type ExecutionId,
  type MessageId,
  type PackageId,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { secretsResolverFor, type IMessage } from "../../src/protocol/didcomm.js";
import {
  AgentTrace,
  Dispatcher,
  Keyring,
  LiveAction,
  LiveInput,
  Receiver,
  createDid,
  dispatch,
  effectTypesOf,
  handlersOf,
  pinnedResolver,
  reactTo,
  completeResponse,
  receiptOf,
  retireDid,
  unpack,
  type EffectOptions,
  type EffectOutcome,
  type Handler,
  type Reacted,
  type Source,
} from "../../src/v3/index.js";
import { didcomm, directParty, peerSealer, posting, refuseCommits, refuseReads, refuseSubmissions, sealed, type DirectParty, type Fresh, type Post } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_NEXT = "019b0000-0000-7000-8000-00000000000b" as DidId;
const ALICE_OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const CREATED = 1_757_700_000;
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const BOB_ENDPOINT = "https://bob.example/didcomm";

const accepted = (): Response => new Response(null, { status: 202 });
/** A transport that refuses the first call and accepts the rest. */
const refusingFirst = (): ((post: Post) => Response) => {
  let calls = 0;
  return () => new Response(null, { status: calls++ === 0 ? 503 : 202 });
};

type Holder = Pick<Fresh, "runtime" | "keys">;

const foldOf = (holder: Holder): Promise<VaultFold> => scanVault(holder.runtime.vault, holder.keys);

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, "https://alice.example/didcomm", ALICE), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...holders: Holder[]): Promise<void> {
  for (const holder of holders) await holder.runtime.close();
}

/** Alice's receiver over her vault's own receipt, and the wire her replies go out on. */
async function reacting(alice: DirectParty, over: Partial<EffectOptions> = {}, answer: (post: Post) => Response = accepted) {
  const ring = await Keyring.load(alice.keys, await foldOf(alice));
  const receiver = new Receiver(alice.runtime, alice.keys, ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
  const wire = posting(answer);
  const effectTypes = effectTypesOf(handlersOf(over.handlers));
  const options: EffectOptions = { dispatch: (action) => dispatch(alice.runtime, alice.keys, action, { didcomm, fetch: wire.fetch, effectTypes }), ...over };
  const receive = async (peer: DirectParty, extra: Partial<IMessage>, as?: string): Promise<EventReference<"message.in">> => {
    const received = await receiver.receive({ packed: await sealed(await peerSealer(peer, as), alice.longFormDid, extra), source: DIRECT });
    if (received.outcome !== "received") throw new Error(`not received: ${JSON.stringify(received)}`);
    return received.eventId;
  };
  const live = async (peer: DirectParty, extra: Partial<IMessage>): Promise<Reacted> => reactTo(alice.runtime, alice.keys, new LiveInput(await receive(peer, extra)), options);
  const executionOf = async (eventId: EventReference<"message.in">): Promise<ExecutionId> => (await foldOf(alice)).inbound.ofSource(eventId)!.id;
  return { receiver, wire, options, effectTypes, receive, live, executionOf };
}

const packageOf = async (holder: Holder, messageId: MessageId): Promise<PackageId> => (await foldOf(holder)).outbound.outbounds.get(messageId)!.package!.event.data.packageId;
const bodyCidOf = async (holder: Holder, executionId: ExecutionId) => (await foldOf(holder)).inbound.executions.get(executionId)!.members[0]!.source.event.data.bodyCid;

const ECHO_TYPE = "https://example.org/echo/1.0/echo";
const ECHO_EFFECT = "https://example.org/echo/1.0#echo";
/** A registered protocol: chat is echoed back under its own operation. */
const echo: Handler = {
  types: [BASIC_MESSAGE],
  effectTypes: [ECHO_EFFECT],
  respond: async (input) => [{ effectType: ECHO_EFFECT, content: { type: ECHO_TYPE, body: { echoed: input.source.event.data.wireMessageId }, thid: input.source.event.data.wireMessageId, pleaseAck: null, ack: [] } }],
};

const ping = (wire: string, extra: Partial<IMessage> = {}): Partial<IMessage> => ({ id: wire, type: PING_TYPE, body: { response_requested: true }, please_ack: [""], created_time: CREATED, ...extra });

const outcomes = (effects: readonly EffectOutcome[]) => effects.map((effect) => [effect.effectType, effect.outcome, "because" in effect ? effect.because : effect.dispatched?.outcome ?? null]);

function created(effect: EffectOutcome | undefined): Extract<EffectOutcome, { outcome: "created" }> {
  if (effect?.outcome !== "created") throw new Error(`not created: ${JSON.stringify(effect)}`);
  return effect;
}

/** The envelope the message's one package names, opened as Bob opens it: with his secrets, the documents each vault holds. */
async function openedByBob(bob: DirectParty, alice: DirectParty, messageId: MessageId): Promise<JsonObject> {
  const outbound = (await foldOf(alice)).outbound.outbounds.get(messageId)!;
  const packed = new TextDecoder().decode((await alice.runtime.vault.objects.read(outbound.package!.event.data.envelopeCid, 1 << 20)) as Uint8Array);
  const ring = await Keyring.load(bob.keys, await foldOf(bob));
  const his = pinnedResolver(await foldOf(bob));
  const hers = pinnedResolver(await foldOf(alice));
  const resolver = { resolve: async (did: string): Promise<DIDDoc | null> => (await his.resolve(did)) ?? hers.resolve(did) };
  return (await unpack(didcomm, packed, resolver, secretsResolverFor(ring.secrets()))).plaintext as unknown as JsonObject;
}

describe("the automatic effects of a live input", () => {
  it("a Ping asking for a receipt and a reply earns two independent intents under their tuples, each dispatched once under an initial action; delivered again it earns nothing new, and an open lists nothing", async () => {
    const { alice, bob } = await parties();
    const { wire, live } = await reacting(alice);
    const wireId = crypto.randomUUID() as WireMessageId;

    const reacted = await live(bob, ping(wireId));
    expect(outcomes(reacted.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "submitted"],
      [PING_RESPONSE_EFFECT, "created", "submitted"],
    ]);
    const [ack, reply] = reacted.effects.map(created);
    expect([ack!.messageId, reply!.messageId]).toEqual([automaticMessageId(effectKey(reacted.executionId!, PURE_ACK_EFFECT)), automaticMessageId(effectKey(reacted.executionId!, PING_RESPONSE_EFFECT))]);
    for (const effect of [ack!, reply!]) {
      expect(effect.action).toBeInstanceOf(LiveAction);
      expect([effect.action.kind, effect.action.spent]).toEqual(["initial", true]);
    }
    expect(ack!.intent.data).toMatchObject({
      msgType: EMPTY_MESSAGE_TYPE,
      thid: wireId,
      pthid: null,
      createdTime: CREATED,
      expiresTime: null,
      pleaseAck: null,
      ack: [wireId],
      senderDidId: ALICE,
      recipientDid: bob.did,
      executionId: reacted.executionId,
      effectType: PURE_ACK_EFFECT,
      sourceEventId: reacted.eventId,
      rotationEventId: null,
    });
    expect(reply!.intent.data).toMatchObject({ msgType: PING_RESPONSE_TYPE, thid: wireId, pthid: null, createdTime: CREATED, expiresTime: null, pleaseAck: null, ack: [], senderDidId: ALICE, recipientDid: bob.did, effectType: PING_RESPONSE_EFFECT, sourceEventId: reacted.eventId });
    expect(wire.posts.map((post) => post.url)).toEqual([BOB_ENDPOINT, BOB_ENDPOINT]);

    let fold = await foldOf(alice);
    for (const messageId of [ack!.messageId, reply!.messageId]) {
      const outbound = fold.outbound.outbounds.get(messageId)!;
      expect([outbound.effect, outbound.outcome, outbound.work.kind]).toEqual([{ status: "complete" }, { status: "submitted" }, "none"]);
    }
    expect(await openedByBob(bob, alice, ack!.messageId)).toMatchObject({ type: EMPTY_MESSAGE_TYPE, thid: wireId, ack: [wireId], body: {} });
    expect(await openedByBob(bob, alice, reply!.messageId)).toMatchObject({ type: PING_RESPONSE_TYPE, thid: wireId, body: {} });

    const again = await live(bob, ping(wireId));
    expect([again.executionId, outcomes(again.effects)]).toEqual([
      reacted.executionId,
      [
        [PURE_ACK_EFFECT, "existing", null],
        [PING_RESPONSE_EFFECT, "existing", null],
      ],
    ]);
    fold = await foldOf(alice);
    expect([wire.posts.length, fold.set.of("message.in").length, fold.set.of("message.out").length, unfinishedWork(fold).responses]).toEqual([2, 2, 2, []]);
    await closeAll(alice, bob);
  });

  it("each operation follows its own policy: a Ping asking for no reply gets its receipt alone, one asking for no receipt its reply alone, chat only what it asks, a pure acknowledgement nothing, an expired Ping no reply, and a request naming nothing here no receipt", async () => {
    const { alice, bob } = await parties();
    const { live } = await reacting(alice, { now: () => (CREATED + 100) * 1000 });

    const noReply = await live(bob, ping(crypto.randomUUID(), { body: { response_requested: false } }));
    expect(outcomes(noReply.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "submitted"],
      [PING_RESPONSE_EFFECT, "none", "the Ping asked for no reply"],
    ]);
    const noReceipt = await live(bob, ping(crypto.randomUUID(), { please_ack: undefined }));
    expect(outcomes(noReceipt.effects)).toEqual([[PING_RESPONSE_EFFECT, "created", "submitted"]]);
    const chat = await live(bob, { type: BASIC_MESSAGE, please_ack: [""] });
    expect(outcomes(chat.effects)).toEqual([[PURE_ACK_EFFECT, "created", "submitted"]]);
    const silent = await live(bob, { type: BASIC_MESSAGE });
    expect(outcomes(silent.effects)).toEqual([]);
    const pureAck = await live(bob, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: [crypto.randomUUID()] });
    expect(outcomes(pureAck.effects)).toEqual([]);
    const expired = await live(bob, ping(crypto.randomUUID(), { expires_time: CREATED + 50 }));
    expect(outcomes(expired.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "submitted"],
      [PING_RESPONSE_EFFECT, "none", "the Ping has expired"],
    ]);
    const stranger = await live(bob, { type: BASIC_MESSAGE, please_ack: [crypto.randomUUID()] });
    expect(outcomes(stranger.effects)).toEqual([[PURE_ACK_EFFECT, "none", "the request names no input of the channel that is established and unambiguous"]]);
    await closeAll(alice, bob);
  });

  it("receipts are local policy: with them off a request is declined and the reply still goes; a registered handler covers a type before the built-in", async () => {
    const { alice, bob } = await parties();
    const declining: Handler = { types: [BASIC_MESSAGE], effectTypes: ["https://example.org/chat#reply"], respond: async () => [{ effectType: "https://example.org/chat#reply", content: null, because: "chat is read, not answered" }] };
    const { live } = await reacting(alice, { acknowledge: false, handlers: [declining] });
    const pinged = await live(bob, ping(crypto.randomUUID()));
    expect(outcomes(pinged.effects)).toEqual([
      [PURE_ACK_EFFECT, "none", "receipts are not given here"],
      [PING_RESPONSE_EFFECT, "created", "submitted"],
    ]);
    const chat = await live(bob, { type: BASIC_MESSAGE, please_ack: [""] });
    expect(outcomes(chat.effects)).toEqual([
      [PURE_ACK_EFFECT, "none", "receipts are not given here"],
      ["https://example.org/chat#reply", "none", "chat is read, not answered"],
    ]);
    await closeAll(alice, bob);
  });

  it("an input that is not live is listed and completed by hand: each completion makes its one intent under the same tuple with a manual action, an erased body forbids a new reply but not the receipt, and a second completion reuses the intent and calls nothing", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive, executionOf } = await reacting(alice);
    const wireId = crypto.randomUUID() as WireMessageId;
    const eventId = await receive(bob, ping(wireId));
    const executionId = await executionOf(eventId);
    let fold = await foldOf(alice);
    expect(unfinishedWork(fold).responses.map((response) => [response.execution.id, response.effectType])).toEqual([
      [executionId, PURE_ACK_EFFECT],
      [executionId, PING_RESPONSE_EFFECT],
    ]);
    expect(wire.posts).toHaveLength(0);

    const messageId = fold.inbound.executions.get(executionId)!.messageId;
    await eraseMessage(alice.runtime, alice.keys, messageId);
    expect(outcomes([await completeResponse(alice.runtime, alice.keys, executionId, PING_RESPONSE_EFFECT, options)])).toEqual([[PING_RESPONSE_EFFECT, "none", "the Ping's body is not here to say whether it asked for a reply"]]);
    const ack = created(await completeResponse(alice.runtime, alice.keys, executionId, PURE_ACK_EFFECT, options));
    expect([ack.action.kind, ack.action.spent, ack.dispatched.outcome, ack.intent.data.ack, wire.posts.length]).toEqual(["manual", true, "submitted", [wireId], 1]);

    const again = await completeResponse(alice.runtime, alice.keys, executionId, PURE_ACK_EFFECT, options);
    expect(again).toMatchObject({ outcome: "existing", messageId: ack.messageId, action: { kind: "manual", spent: false }, dispatched: { outcome: "none", because: "submitted" } });
    expect(outcomes([await completeResponse(alice.runtime, alice.keys, executionId, "https://example.org/unknown", options)])).toEqual([["https://example.org/unknown", "none", "no operation here gives the input this output"]]);
    fold = await foldOf(alice);
    expect([wire.posts.length, unfinishedWork(fold).responses.map((response) => response.effectType)]).toEqual([1, []]);
    await closeAll(alice, bob);
  });

  it("one operation's record refused by the disk leaves the other's intent standing and dispatched, is traced, and is made later by hand", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { wire, options, live } = await reacting(alice, { trace });
    refuseCommits(alice.runtime, "message.out", 1);
    const reacted = await live(bob, ping(crypto.randomUUID()));
    expect(outcomes(reacted.effects)).toEqual([
      [PURE_ACK_EFFECT, "refused", "the disk is full for now"],
      [PING_RESPONSE_EFFECT, "created", "submitted"],
    ]);
    const ackId = automaticMessageId(effectKey(reacted.executionId!, PURE_ACK_EFFECT));
    expect((await trace.read({ type: "diag.effect" })).map((entry) => entry.data)).toEqual([{ messageId: ackId, executionId: reacted.executionId, effectType: PURE_ACK_EFFECT, reason: "the disk is full for now" }]);
    expect(wire.posts).toHaveLength(1);
    const ack = created(await completeResponse(alice.runtime, alice.keys, reacted.executionId!, PURE_ACK_EFFECT, options));
    expect([ack.messageId, ack.action.kind, ack.dispatched.outcome, wire.posts.length]).toEqual([ackId, "manual", "submitted", 2]);
    await closeAll(alice, bob);
  });

  it("a registered handler's operation is this runtime's work end to end: its intent is prepared and called under the initial action, listed by a dispatcher told of it, retried by hand as the same package, and no work of a scan not told of it", async () => {
    const { alice, bob } = await parties();
    const { wire, effectTypes, live } = await reacting(alice, { handlers: [echo] }, refusingFirst());
    const wireId = crypto.randomUUID() as WireMessageId;
    const reacted = await live(bob, { id: wireId, type: BASIC_MESSAGE, body: { content: "hi" } });
    expect(outcomes(reacted.effects)).toEqual([[ECHO_EFFECT, "created", "failed"]]);
    const { messageId } = created(reacted.effects[0]);
    const packageId = await packageOf(alice, messageId);
    expect(wire.posts).toHaveLength(1);

    const untold = await dispatch(alice.runtime, alice.keys, new LiveAction(messageId, "manual"), { didcomm, fetch: wire.fetch });
    expect([untold.outcome, wire.posts.length]).toEqual(["none", 1]);
    const dispatcher = new Dispatcher(alice.runtime, alice.keys, { didcomm, fetch: wire.fetch, effectTypes });
    expect((await dispatcher.pending()).map((pending) => [pending.outbound.messageId, pending.outbound.work.kind])).toEqual([[messageId, "dispatch"]]);
    const retried = await dispatcher.retry(messageId);
    expect(retried).toMatchObject({ outcome: "submitted", packageId });
    expect(wire.posts).toHaveLength(2);
    expect(await openedByBob(bob, alice, messageId)).toMatchObject({ type: ECHO_TYPE, thid: wireId, body: { echoed: wireId } });
    dispatcher.close();
    await closeAll(alice, bob);
  });

  it("an intent already under the tuple is reused before the body is read or the handler asked: a prepared reply goes out by hand as the same package when its handler would now decide otherwise, and when the disk refuses the Ping's body", async () => {
    const { alice, bob } = await parties();
    const { wire, options, live } = await reacting(alice, {}, refusingFirst());
    const reacted = await live(bob, ping(crypto.randomUUID(), { please_ack: undefined }));
    expect(outcomes(reacted.effects)).toEqual([[PING_RESPONSE_EFFECT, "created", "failed"]]);
    const { messageId } = created(reacted.effects[0]);
    const packageId = await packageOf(alice, messageId);

    const otherwise: Handler = { types: [PING_TYPE], effectTypes: [PING_RESPONSE_EFFECT], respond: async () => [] };
    const declined = await completeResponse(alice.runtime, alice.keys, reacted.executionId!, PING_RESPONSE_EFFECT, { ...options, handlers: [otherwise] });
    expect(declined).toMatchObject({ outcome: "existing", messageId, action: { kind: "manual", spent: true }, dispatched: { outcome: "submitted", packageId } });

    refuseReads(alice.runtime, await bodyCidOf(alice, reacted.executionId!));
    const unread = await completeResponse(alice.runtime, alice.keys, reacted.executionId!, PING_RESPONSE_EFFECT, options);
    expect(unread).toMatchObject({ outcome: "existing", messageId, action: { kind: "manual", spent: false }, dispatched: { outcome: "none", because: "submitted" } });
    expect(wire.posts).toHaveLength(2);
    await closeAll(alice, bob);
  });

  it("each operation is its own boundary: the disk refusing the Ping's body costs the reply alone and the receipt goes; the disk refusing to record an acceptance once costs the receipt's call step alone, the reply goes, and the acceptance is recorded by the next action without a second call", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { wire, options, receive, live } = await reacting(alice, { trace });
    const eventId = await receive(bob, ping(crypto.randomUUID()));
    const executionId = (await foldOf(alice)).inbound.ofSource(eventId)!.id;
    refuseReads(alice.runtime, await bodyCidOf(alice, executionId), 1);
    const unread = await reactTo(alice.runtime, alice.keys, new LiveInput(eventId), options);
    expect(outcomes(unread.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "submitted"],
      [PING_RESPONSE_EFFECT, "refused", "the disk refuses the read"],
    ]);
    const replyId = automaticMessageId(effectKey(executionId, PING_RESPONSE_EFFECT));
    expect((await trace.read({ type: "diag.effect" })).map((entry) => entry.data)).toEqual([{ messageId: replyId, executionId, effectType: PING_RESPONSE_EFFECT, reason: "the disk refuses the read" }]);
    const reply = created(await completeResponse(alice.runtime, alice.keys, executionId, PING_RESPONSE_EFFECT, options));
    expect([reply.messageId, reply.action.kind, reply.dispatched.outcome, wire.posts.length]).toEqual([replyId, "manual", "submitted", 2]);

    refuseSubmissions(alice.runtime, 1);
    const unrecorded = await live(bob, ping(crypto.randomUUID()));
    expect(outcomes(unrecorded.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "threw"],
      [PING_RESPONSE_EFFECT, "created", "submitted"],
    ]);
    const [ack] = unrecorded.effects.map(created);
    expect([ack!.action.spent, ack!.dispatched, wire.posts.length]).toEqual([true, { outcome: "threw", messageId: ack!.messageId, reason: "the disk is full for now" }, 4]);
    expect((await trace.read({ type: "diag.effect" })).map((entry) => entry.data)).toContainEqual({ messageId: ack!.messageId, executionId: unrecorded.executionId, effectType: PURE_ACK_EFFECT, reason: "the disk is full for now" });
    const recorded = await dispatch(alice.runtime, alice.keys, new LiveAction(ack!.messageId, "manual"), { didcomm, fetch: wire.fetch });
    expect([recorded.outcome, wire.posts.length, (await foldOf(alice)).outbound.outbounds.get(ack!.messageId)!.outcome]).toEqual(["submitted", 4, { status: "submitted" }]);
    await closeAll(alice, bob);
  });

  it("the reply goes by the carrier's channel while its local DID sends, even with a successor selected; once that DID is retired, by the unique verified successor keeping the peer, carrying the rotation's proof; a competing successor leaves no channel", async () => {
    const { alice, bob } = await parties();
    const { options, receive, executionOf } = await reacting(alice);
    const executionId = await executionOf(await receive(bob, ping(crypto.randomUUID())));
    const routeId = (await foldOf(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    const { minted: next } = await createDid(alice.runtime, alice.keys, routeId, ALICE_NEXT);
    const fromPrior = await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, next.longFormDid, IAT);
    const [decision] = await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: bob.did, toDidId: ALICE_NEXT, sourceEventId: null, fromPrior })]);
    expect((await foldOf(alice)).continuity.status(decision!.eventId)).toEqual({ status: "verified" });

    const ack = created(await completeResponse(alice.runtime, alice.keys, executionId, PURE_ACK_EFFECT, options));
    expect([ack.intent.data.senderDidId, ack.intent.data.recipientDid, ack.dispatched.outcome]).toEqual([ALICE, bob.did, "submitted"]);

    await retireDid(alice.runtime, alice.keys, ALICE, "rotated");
    const reply = created(await completeResponse(alice.runtime, alice.keys, executionId, PING_RESPONSE_EFFECT, options));
    expect([reply.intent.data.senderDidId, reply.intent.data.recipientDid, reply.dispatched.outcome]).toEqual([ALICE_NEXT, bob.did, "submitted"]);
    const fold = await foldOf(alice);
    expect(fold.outbound.outbounds.get(reply.messageId)!.channel).toEqual({ localDid: next.did, peerDid: bob.did });
    expect(await openedByBob(bob, alice, reply.messageId)).toMatchObject({ type: PING_RESPONSE_TYPE, from: next.longFormDid, from_prior: fromPrior });

    const { minted: other } = await createDid(alice.runtime, alice.keys, routeId, ALICE_OTHER);
    await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: bob.did, toDidId: ALICE_OTHER, sourceEventId: null, fromPrior: await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, other.longFormDid, IAT) })]);
    const later = await executionOf(await receive(bob, ping(crypto.randomUUID())));
    expect(outcomes([await completeResponse(alice.runtime, alice.keys, later, PURE_ACK_EFFECT, options)])).toEqual([[PURE_ACK_EFFECT, "none", "the channel's continuity is in conflict"]]);
    await closeAll(alice, bob);
  });

  it("no effect for a denied channel, for the input of a peer that has replaced its DID, or for an anonymous observation", async () => {
    const { alice, bob } = await parties();
    const { receiver, options, receive, live, executionOf } = await reacting(alice);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const old = await executionOf(await receive(bob, ping(crypto.randomUUID()), prior.longFormDid));
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    const moved = await live(bob, ping(crypto.randomUUID(), { from_prior: proof }));
    expect(outcomes(moved.effects)).toEqual([
      [PURE_ACK_EFFECT, "created", "submitted"],
      [PING_RESPONSE_EFFECT, "created", "submitted"],
    ]);
    expect(outcomes([await completeResponse(alice.runtime, alice.keys, old, PURE_ACK_EFFECT, options)])).toEqual([[PURE_ACK_EFFECT, "none", "the peer has replaced its DID"]]);

    await blockChannels(alice.runtime, alice.keys, [{ localDid: alice.did, peerDid: bob.did }], false);
    const denied = await live(bob, ping(crypto.randomUUID()));
    expect(outcomes(denied.effects)).toEqual([
      [PURE_ACK_EFFECT, "none", "the channel is denied"],
      [PING_RESPONSE_EFFECT, "none", "the channel is denied"],
    ]);

    const anonymous = await receiver.receive({ packed: await sealed(null, alice.longFormDid, { type: BASIC_MESSAGE, please_ack: [""] }), source: DIRECT });
    if (anonymous.outcome !== "received") throw new Error(`not received: ${JSON.stringify(anonymous)}`);
    const reacted = await reactTo(alice.runtime, alice.keys, new LiveInput(anonymous.eventId), options);
    expect(reacted).toEqual({ eventId: anonymous.eventId, executionId: null, because: "the observation is anonymous or in no input here", effects: [] });
    await closeAll(alice, bob);
  });
});
