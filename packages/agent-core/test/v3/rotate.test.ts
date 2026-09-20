import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";

import type { DIDDoc } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store/v3";
import {
  EMPTY_MESSAGE_TYPE,
  PING_RESPONSE_EFFECT,
  PING_TYPE,
  PURE_ACK_EFFECT,
  ROTATION_NOTIFICATION_EFFECT,
  automaticMessageId,
  blockChannels,
  channelKey,
  effectKey,
  fromPriorClaims,
  scanVault,
  signFromPrior,
  unfinishedWork,
  vaultDraft,
  type Did,
  type DidId,
  type EventReference,
  type MessageId,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { secretsResolverFor, type IMessage } from "../../src/protocol/didcomm.js";
import {
  AgentTrace,
  Keyring,
  LiveInput,
  NotificationConflict,
  Receiver,
  UnknownEntity,
  Unusable,
  completeNotification,
  createDid,
  disclose,
  dispatch,
  manualNotificationDraft,
  pinnedResolver,
  privateAddress,
  reactTo,
  receiptOf,
  rotate,
  unpack,
  type EffectOutcome,
  type Reacted,
  type RotateOptions,
  type Rotated,
  type Source,
} from "../../src/v3/index.js";
import { didcomm, directParty, peerSealer, posting, refuseCommits, sealed, type DirectParty, type Fresh, type Post } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const ALICE_NEXT = "019b0000-0000-7000-8000-00000000000b" as DidId;
const ALICE_OTHER = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const BOB_PRIOR = "019b0000-0000-7000-8000-0000000000b1" as DidId;
const BOB_FORK = "019b0000-0000-7000-8000-0000000000b2" as DidId;
const BOB_OTHER_FORK = "019b0000-0000-7000-8000-0000000000b3" as DidId;
const CHARLIE = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const CREATED = 1_757_700_000;
const IAT = 1_757_700_000;

const DIRECT: Source = { kind: "direct" };
const BOB_ENDPOINT = "https://bob.example/didcomm";

const accepted = (): Response => new Response(null, { status: 202 });

type Holder = Pick<Fresh, "runtime" | "keys">;

const foldOf = (holder: Holder): Promise<VaultFold> => scanVault(holder.runtime.vault, holder.keys);

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty }> {
  return { alice: await directParty(1, "https://alice.example/didcomm", ALICE), bob: await directParty(2, BOB_ENDPOINT, BOB) };
}

async function closeAll(...holders: Holder[]): Promise<void> {
  for (const holder of holders) await holder.runtime.close();
}

/** Alice's receiver over her vault's own receipt, the wire her messages go out on, and the options every rotation takes. */
async function rotating(alice: DirectParty, over: Partial<RotateOptions> = {}, answer: (post: Post) => Response = accepted) {
  const ring = await Keyring.load(alice.keys, await foldOf(alice));
  const receiver = new Receiver(alice.runtime, alice.keys, ring, { didcomm, receipt: receiptOf(alice.runtime, alice.keys) });
  const wire = posting(answer);
  const options: RotateOptions = { dispatch: (action) => dispatch(alice.runtime, alice.keys, action, { didcomm, fetch: wire.fetch }), now: () => IAT * 1000, ...over };
  const receive = async (peer: DirectParty, extra: Partial<IMessage>, as?: string, to: string = alice.longFormDid): Promise<EventReference<"message.in">> => {
    const received = await receiver.receive({ packed: await sealed(await peerSealer(peer, as), to, extra), source: DIRECT });
    if (received.outcome !== "received") throw new Error(`not received: ${JSON.stringify(received)}`);
    return received.eventId;
  };
  const live = async (peer: DirectParty, extra: Partial<IMessage>, to?: string): Promise<Reacted> => reactTo(alice.runtime, alice.keys, new LiveInput(await receive(peer, extra, undefined, to)), options);
  return { receiver, wire, options, receive, live };
}

const ping = (wire: string, extra: Partial<IMessage> = {}): Partial<IMessage> => ({ id: wire, type: PING_TYPE, body: { response_requested: true }, please_ack: [""], created_time: CREATED, ...extra });

function created(effect: EffectOutcome | undefined): Extract<EffectOutcome, { outcome: "created" }> {
  if (effect?.outcome !== "created") throw new Error(`not created: ${JSON.stringify(effect)}`);
  return effect;
}

function rotated(privacy: Awaited<ReturnType<typeof privateAddress>>): Rotated {
  if (privacy.outcome !== "rotated") throw new Error(`not rotated: ${JSON.stringify(privacy)}`);
  return privacy.rotation;
}

const successorOf = async (holder: Holder, rotation: Rotated) => (await foldOf(holder)).routes.dids.get(rotation.successor)!.created!;

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

describe("a local rotation", () => {
  it("a manual rotation mints the successor and freezes the decision in one commit, notifies the peer once under an initial action carrying the proof, and asked again reuses the decision and mints nothing", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    await receive(bob, { type: BASIC_MESSAGE });

    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.longFormDid }, options);
    expect([rotation.existed, rotation.channel]).toEqual([false, { localDid: alice.did, peerDid: bob.did }]);
    const successor = await successorOf(alice, rotation);
    expect(rotation.decision.data).toMatchObject({ fromDidId: ALICE, peerDid: bob.did, toDidId: rotation.successor, sourceEventId: null });
    expect(fromPriorClaims(rotation.decision.data.fromPrior)).toMatchObject({ iss: alice.longFormDid, sub: successor.longFormDid, iat: IAT });
    let fold = await foldOf(alice);
    const creation = fold.set.of("did.created").find((event) => event.data.didId === rotation.successor)!;
    expect([creation.at, successor.boundRouteId]).toEqual([rotation.decision.at, fold.routes.dids.get(ALICE)!.created!.boundRouteId]);
    expect(fold.continuity.status(rotation.decision.eventId)).toEqual({ status: "verified" });
    expect(fold.continuity.head({ localDid: alice.did, peerDid: bob.did })).toEqual({ localDid: successor.did, peerDid: bob.did });

    const notification = created(rotation.notification);
    expect([notification.action.kind, notification.action.spent, notification.dispatched.outcome, wire.posts.map((post) => post.url)]).toEqual(["initial", true, "submitted", [BOB_ENDPOINT]]);
    expect(notification.intent.data).toMatchObject({
      msgType: EMPTY_MESSAGE_TYPE,
      thid: null,
      pthid: null,
      createdTime: null,
      expiresTime: null,
      pleaseAck: [""],
      ack: [],
      senderDidId: rotation.successor,
      recipientDid: bob.did,
      executionId: null,
      effectType: null,
      effectKey: null,
      sourceEventId: null,
      rotationEventId: rotation.decision.eventId,
    });
    expect(fold.outbound.notificationFor(rotation.decision.eventId)).toEqual({ status: "selected", messageId: notification.messageId });
    expect(fold.outbound.outbounds.get(notification.messageId)!.effect).toEqual({ status: "complete" });
    expect(await openedByBob(bob, alice, notification.messageId)).toMatchObject({ type: EMPTY_MESSAGE_TYPE, from: successor.longFormDid, from_prior: rotation.decision.data.fromPrior, please_ack: [""], body: {} });
    expect(unfinishedWork(fold).notifications).toEqual([]);

    const again = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    expect(again).toMatchObject({ existed: true, decision: { eventId: rotation.decision.eventId }, successor: rotation.successor, notification: { outcome: "existing", messageId: notification.messageId, action: null, dispatched: null } });
    fold = await foldOf(alice);
    expect([fold.routes.dids.size, fold.set.of("did.rotationSelected").length, wire.posts.length]).toEqual([2, 1, 1]);
    await closeAll(alice, bob);
  });

  it("no rotation from an address the peer never wrote to, in a denied channel, toward oneself, from an unknown entity, over a control input, or where decisions already compete", async () => {
    const { alice, bob } = await parties();
    const { options, receive } = await rotating(alice);
    const target = { localDidId: ALICE, peerDid: bob.did };
    await expect(rotate(alice.runtime, alice.keys, target, options)).rejects.toThrow(new Unusable("channel", channelKey({ localDid: alice.did, peerDid: bob.did }), ["the peer has not written to exactly this address"]));
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: alice.longFormDid }, options)).rejects.toThrow(Unusable);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE_NEXT, peerDid: bob.did }, options)).rejects.toThrow(UnknownEntity);

    const control = await receive(bob, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: [crypto.randomUUID()] });
    await expect(rotate(alice.runtime, alice.keys, { ...target, sourceEventId: control }, options)).rejects.toThrow("a control input selects no rotation: it is pure-ack");

    await blockChannels(alice.runtime, alice.keys, [{ localDid: alice.did, peerDid: bob.did }], false);
    await expect(rotate(alice.runtime, alice.keys, target, options)).rejects.toThrow("the channel is denied");
    await closeAll(alice, bob);

    const fresh = await parties();
    const { options: fresh0, receive: written } = await rotating(fresh.alice);
    await written(fresh.bob, { type: BASIC_MESSAGE });
    const routeId = (await foldOf(fresh.alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    for (const didId of [ALICE_NEXT, ALICE_OTHER]) {
      const { minted } = await createDid(fresh.alice.runtime, fresh.alice.keys, routeId, didId);
      const fromPrior = await signFromPrior(fresh.alice.keys, { didId: ALICE, longFormDid: fresh.alice.longFormDid }, minted.longFormDid, IAT);
      await fresh.alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: fresh.bob.did, toDidId: didId, sourceEventId: null, fromPrior })]);
    }
    await expect(rotate(fresh.alice.runtime, fresh.alice.keys, target, fresh0)).rejects.toThrow(Unusable);
    expect((await foldOf(fresh.alice)).routes.dids.size).toBe(3);
    await closeAll(fresh.alice, fresh.bob);
  });

  it("an entity recorded earlier is a manual rotation's successor only while the decision folds without conflict, and never the policy's: a rotation back to the predecessor and a policy rotation to a disclosed address are refused before anything is written, and a fresh ID given to the policy is taken", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    await receive(bob, { type: BASIC_MESSAGE });
    const forward = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, { ...options, didId: ALICE_NEXT });
    const successor = await successorOf(alice, forward);
    await receive(bob, { type: BASIC_MESSAGE }, undefined, successor.longFormDid);
    let fold = await foldOf(alice);
    expect(fold.continuity.confirmed(successor.did, bob.did)).toBe(true);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE_NEXT, peerDid: bob.did }, { ...options, didId: ALICE })).rejects.toThrow(new Unusable("DID", ALICE, ["the decision would be in conflict: its context is in conflict: cycle"]));
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.routes.dids.size, fold.continuity.head({ localDid: alice.did, peerDid: bob.did }), fold.continuity.conflicts, wire.posts.length]).toEqual([1, 2, { localDid: successor.did, peerDid: bob.did }, [], 1]);
    await closeAll(alice, bob);

    const disclosed = await parties();
    const routeId = (await foldOf(disclosed.alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    await createDid(disclosed.alice.runtime, disclosed.alice.keys, routeId, ALICE_OTHER);
    for (const didId of [ALICE, ALICE_OTHER]) await disclose(null, disclosed.alice.runtime, disclosed.alice.keys, didId, { as: "direct", uses: "many" });
    const { wire: theirs, options: policy, receive: written } = await rotating(disclosed.alice);
    const chat = await written(disclosed.bob, { type: BASIC_MESSAGE });
    await expect(privateAddress(disclosed.alice.runtime, disclosed.alice.keys, new LiveInput(chat), { ...policy, didId: ALICE_OTHER })).rejects.toThrow(new Unusable("DID", ALICE_OTHER, ["a rotation an input selects takes a fresh successor"]));
    fold = await foldOf(disclosed.alice);
    expect([fold.set.of("did.rotationSelected"), fold.set.of("message.out"), theirs.posts.length, fold.routes.dids.size]).toEqual([[], [], 0, 2]);
    const fresh = rotated(await privateAddress(disclosed.alice.runtime, disclosed.alice.keys, new LiveInput(chat), { ...policy, didId: ALICE_NEXT }));
    expect([fresh.successor, fresh.decision.data.sourceEventId, fresh.notification.outcome, theirs.posts.length, (await foldOf(disclosed.alice)).routes.dids.size]).toEqual([ALICE_NEXT, chat, "created", 1, 3]);
    await closeAll(disclosed.alice, disclosed.bob);
  });

  it("a decision is folded with the evidence here before it is written: one whose join would confirm a waiting decision closing a cycle is refused with nothing written, while the same local DIDs rotate back and forth toward unrelated peers, each context keeping its own head", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    const bobRoute = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_PRIOR);
    await receive(bob, { type: BASIC_MESSAGE }, prior.longFormDid);
    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    await receive(bob, { type: BASIC_MESSAGE, from_prior: proof });
    const aliceRoute = (await foldOf(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    const { minted: next } = await createDid(alice.runtime, alice.keys, aliceRoute, ALICE_NEXT);
    await receive(bob, { type: BASIC_MESSAGE }, undefined, next.longFormDid);
    const waiting = await signFromPrior(alice.keys, { didId: ALICE_NEXT, longFormDid: next.longFormDid }, alice.longFormDid, IAT);
    const [pending] = await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE_NEXT, peerDid: prior.did, toDidId: ALICE, sourceEventId: null, fromPrior: waiting })]);
    const old = { localDid: alice.did, peerDid: prior.did };
    let fold = await foldOf(alice);
    expect([fold.continuity.status(pending!.eventId).status, fold.continuity.confirmed(alice.did, prior.did), fold.continuity.head(old)]).toEqual(["pending-history", true, { localDid: alice.did, peerDid: bob.did }]);
    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: prior.did }, { ...options, didId: ALICE_NEXT })).rejects.toThrow(new Unusable("DID", ALICE_NEXT, ["the decision would be in conflict: its context is in conflict: cycle"]));
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.routes.dids.size, fold.continuity.head(old), fold.continuity.conflicts, wire.posts.length]).toEqual([1, 2, { localDid: alice.did, peerDid: bob.did }, [], 0]);
    await closeAll(alice, bob);

    const three = await parties();
    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    const { wire: hers, options: theirs, receive: written } = await rotating(three.alice);
    await written(three.bob, { type: BASIC_MESSAGE });
    const forward = await rotate(three.alice.runtime, three.alice.keys, { localDidId: ALICE, peerDid: three.bob.did }, { ...theirs, didId: ALICE_NEXT });
    const successor = await successorOf(three.alice, forward);
    await written(charlie, { type: BASIC_MESSAGE }, undefined, successor.longFormDid);
    const back = await rotate(three.alice.runtime, three.alice.keys, { localDidId: ALICE_NEXT, peerDid: charlie.did }, { ...theirs, didId: ALICE });
    expect([back.existed, back.successor, back.decision.data.peerDid, back.notification.outcome]).toEqual([false, ALICE, charlie.did, "created"]);
    fold = await foldOf(three.alice);
    expect(fold.continuity.status(back.decision.eventId)).toEqual({ status: "verified" });
    expect([fold.continuity.conflicts, fold.routes.dids.size, hers.posts.map((post) => post.url)]).toEqual([[], 2, [BOB_ENDPOINT, "https://charlie.example/didcomm"]]);
    expect([fold.continuity.head({ localDid: three.alice.did, peerDid: three.bob.did }), fold.continuity.head({ localDid: successor.did, peerDid: charlie.did })]).toEqual([
      { localDid: successor.did, peerDid: three.bob.did },
      { localDid: three.alice.did, peerDid: charlie.did },
    ]);
    await closeAll(three.alice, three.bob, charlie);
  });

  it("a decision whose joins would carry an existing peer fork into a channel no conflict reached is refused with nothing written, while a rotation the fork does not touch goes through beside it", async () => {
    const { alice, bob } = await parties();
    const { wire, options, receive } = await rotating(alice);
    const bobRoute = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_PRIOR);
    const { minted: fork } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_FORK);
    const { minted: otherFork } = await createDid(bob.runtime, bob.keys, bobRoute, BOB_OTHER_FORK);
    const aliceRoute = (await foldOf(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
    const { minted: next } = await createDid(alice.runtime, alice.keys, aliceRoute, ALICE_NEXT);
    await receive(bob, { type: BASIC_MESSAGE }, prior.longFormDid);
    const proofs: [{ didId: DidId; longFormDid: Did }, Did][] = [
      [{ didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid],
      [{ didId: BOB, longFormDid: bob.longFormDid }, fork.longFormDid],
      [{ didId: BOB, longFormDid: bob.longFormDid }, otherFork.longFormDid],
    ];
    for (const [from, to] of proofs) await receive(bob, { type: BASIC_MESSAGE, from_prior: await signFromPrior(bob.keys, from, to, IAT) }, to);
    await receive(bob, { type: BASIC_MESSAGE }, fork.longFormDid, next.longFormDid);
    const healthy = { localDid: next.did, peerDid: fork.did };
    let fold = await foldOf(alice);
    expect([fold.continuity.conflicts.map((conflict) => conflict.kind), fold.continuity.conflicted(healthy), fold.continuity.head(healthy), fold.continuity.confirmed(alice.did, prior.did)]).toEqual([["competing-peer-successors"], false, healthy, true]);

    await expect(rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: prior.did }, { ...options, didId: ALICE_NEXT })).rejects.toThrow(/^DID 019b0000-0000-7000-8000-00000000000b is not usable: the decision would put \[.*\] in conflict: competing-peer-successors$/);
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.set.of("message.out").length, fold.routes.dids.size, fold.continuity.conflicted(healthy), fold.continuity.head(healthy), wire.posts.length]).toEqual([0, 0, 2, false, healthy, 0]);

    const charlie = await directParty(3, "https://charlie.example/didcomm", CHARLIE);
    await receive(charlie, { type: BASIC_MESSAGE }, undefined, next.longFormDid);
    const beside = await rotate(alice.runtime, alice.keys, { localDidId: ALICE_NEXT, peerDid: charlie.did }, options);
    fold = await foldOf(alice);
    expect([beside.existed, fold.continuity.status(beside.decision.eventId), fold.continuity.conflicts.length, beside.notification.outcome, wire.posts.length, fold.routes.dids.size]).toEqual([false, { status: "verified" }, 1, "created", 1, 3]);
    await closeAll(alice, bob, charlie);
  });

  it("the private-address policy: the first live application input at a disclosed address selects a successor over that input and notifies on its thread; a later input reuses the decision; one at the undisclosed successor, a control input or an undisclosed address selects nothing", async () => {
    const { alice, bob } = await parties();
    await disclose(null, alice.runtime, alice.keys, ALICE, { as: "direct", uses: "many" });
    const { wire, options, receive, live } = await rotating(alice);
    const wireId = crypto.randomUUID() as WireMessageId;
    const reacted = await live(bob, ping(wireId));
    expect(reacted.effects.map((effect) => [effect.effectType, effect.outcome])).toEqual([
      [PURE_ACK_EFFECT, "created"],
      [PING_RESPONSE_EFFECT, "created"],
    ]);
    const rotation = rotated(await privateAddress(alice.runtime, alice.keys, new LiveInput(reacted.eventId), options));
    expect([rotation.existed, rotation.decision.data.sourceEventId, rotation.decision.data.peerDid]).toEqual([false, reacted.eventId, bob.did]);
    const successor = await successorOf(alice, rotation);
    const notification = created(rotation.notification);
    expect(notification.messageId).toBe(automaticMessageId(effectKey(reacted.executionId!, ROTATION_NOTIFICATION_EFFECT)));
    expect(notification.intent.data).toMatchObject({ msgType: EMPTY_MESSAGE_TYPE, thid: wireId, pthid: null, createdTime: CREATED, pleaseAck: [""], ack: [], senderDidId: rotation.successor, recipientDid: bob.did, executionId: reacted.executionId, effectType: ROTATION_NOTIFICATION_EFFECT, sourceEventId: reacted.eventId, rotationEventId: rotation.decision.eventId });
    expect([notification.action.kind, notification.dispatched.outcome, wire.posts.length]).toEqual(["initial", "submitted", 3]);
    expect(await openedByBob(bob, alice, notification.messageId)).toMatchObject({ type: EMPTY_MESSAGE_TYPE, thid: wireId, from: successor.longFormDid, from_prior: rotation.decision.data.fromPrior });
    let fold = await foldOf(alice);
    expect([fold.outbound.outbounds.get(notification.messageId)!.effect, unfinishedWork(fold).notifications]).toEqual([{ status: "complete" }, []]);

    const later = await live(bob, ping(crypto.randomUUID()));
    expect(await privateAddress(alice.runtime, alice.keys, new LiveInput(later.eventId), options)).toEqual({ outcome: "reused", decision: rotation.decision });
    fold = await foldOf(alice);
    expect([fold.routes.dids.size, fold.set.of("did.rotationSelected").length, fold.set.of("message.out").length, wire.posts.length]).toEqual([2, 1, 5, 5]);

    const atSuccessor = await receive(bob, { type: BASIC_MESSAGE }, undefined, successor.longFormDid);
    expect(await privateAddress(alice.runtime, alice.keys, new LiveInput(atSuccessor), options)).toEqual({ outcome: "none", because: "the local DID is not disclosed" });
    expect((await foldOf(alice)).continuity.confirmed(successor.did, bob.did)).toBe(true);
    const control = await receive(bob, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: [wireId] });
    expect(await privateAddress(alice.runtime, alice.keys, new LiveInput(control), options)).toEqual({ outcome: "none", because: "a control input selects no rotation: it is pure-ack" });
    await closeAll(alice, bob);

    const undisclosed = await parties();
    const { options: theirs, receive: written } = await rotating(undisclosed.alice);
    const chat = await written(undisclosed.bob, { type: BASIC_MESSAGE });
    expect(await privateAddress(undisclosed.alice.runtime, undisclosed.alice.keys, new LiveInput(chat), theirs)).toEqual({ outcome: "none", because: "the local DID is not disclosed" });
    expect((await foldOf(undisclosed.alice)).set.of("did.rotationSelected")).toEqual([]);
    await closeAll(undisclosed.alice, undisclosed.bob);
  });

  it("a decision whose notification the disk refused is listed and completed by hand under a manual action; completed again it calls nothing; several intents naming it are a conflict no completion resolves", async () => {
    const { alice, bob } = await parties();
    const trace = await AgentTrace.open(alice.runtime.local);
    const { wire, options, receive } = await rotating(alice, { trace });
    await receive(bob, { type: BASIC_MESSAGE });
    refuseCommits(alice.runtime, "message.out", 1);
    const rotation = await rotate(alice.runtime, alice.keys, { localDidId: ALICE, peerDid: bob.did }, options);
    expect([rotation.existed, rotation.notification.outcome, wire.posts.length]).toEqual([false, "refused", 0]);
    expect((await trace.read({ type: "diag.effect" })).map((entry) => entry.data)).toMatchObject([{ executionId: null, effectType: ROTATION_NOTIFICATION_EFFECT, reason: "the disk is full for now" }]);
    const successor = await successorOf(alice, rotation);
    let fold = await foldOf(alice);
    expect(unfinishedWork(fold).notifications.map((missing) => [missing.decision.event.eventId, missing.channel, missing.source])).toEqual([[rotation.decision.eventId, { localDid: successor.did, peerDid: bob.did }, null]]);
    const rotationEventId = rotation.decision.eventId as EventReference<"did.rotationSelected">;

    const completed = created(await completeNotification(alice.runtime, alice.keys, rotationEventId, options));
    expect([completed.action.kind, completed.action.spent, completed.dispatched.outcome, wire.posts.length]).toEqual(["manual", true, "submitted", 1]);
    expect(completed.intent.data).toMatchObject({ senderDidId: rotation.successor, recipientDid: bob.did, rotationEventId: rotation.decision.eventId, sourceEventId: null, thid: null });
    const again = await completeNotification(alice.runtime, alice.keys, rotationEventId, options);
    expect(again).toMatchObject({ outcome: "existing", messageId: completed.messageId, action: { kind: "manual", spent: false }, dispatched: { outcome: "none", because: "submitted" } });
    await expect(completeNotification(alice.runtime, alice.keys, crypto.randomUUID() as EventReference<"did.rotationSelected">, options)).rejects.toThrow(UnknownEntity);

    fold = await foldOf(alice);
    const other = manualNotificationDraft(fold, uuidv7() as MessageId, { localDid: successor.did, peerDid: bob.did }, { type: EMPTY_MESSAGE_TYPE, body: {}, pleaseAck: [""], ack: [] }, rotationEventId);
    await alice.runtime.vault.commit(other.objects, [other.draft]);
    await expect(completeNotification(alice.runtime, alice.keys, rotationEventId, options)).rejects.toThrow(NotificationConflict);
    fold = await foldOf(alice);
    expect([unfinishedWork(fold).notificationConflicts.length, fold.outbound.outbounds.get(completed.messageId)!.work.kind, wire.posts.length]).toEqual([1, "none", 1]);
    await closeAll(alice, bob);
  });

  it("a selecting input whose peer has since replaced its DID permits no missing notification to be made, while the decision stands and is reused", async () => {
    const { alice, bob } = await parties();
    await disclose(null, alice.runtime, alice.keys, ALICE, { as: "direct", uses: "many" });
    const { wire, options, receive } = await rotating(alice);
    const routeId = (await foldOf(bob)).routes.dids.get(BOB)!.created!.boundRouteId;
    const { minted: prior } = await createDid(bob.runtime, bob.keys, routeId, BOB_PRIOR);
    const first = await receive(bob, ping(crypto.randomUUID()), prior.longFormDid);
    refuseCommits(alice.runtime, "message.out", 1);
    const rotation = rotated(await privateAddress(alice.runtime, alice.keys, new LiveInput(first), options));
    expect([rotation.notification.outcome, rotation.decision.data.peerDid]).toEqual(["refused", prior.did]);
    const rotationEventId = rotation.decision.eventId as EventReference<"did.rotationSelected">;
    expect(unfinishedWork(await foldOf(alice)).notifications.map((missing) => missing.decision.event.eventId)).toEqual([rotation.decision.eventId]);

    const proof = await signFromPrior(bob.keys, { didId: BOB_PRIOR, longFormDid: prior.longFormDid }, bob.longFormDid, IAT);
    const moved = await receive(bob, ping(crypto.randomUUID(), { from_prior: proof }));
    let fold = await foldOf(alice);
    expect([fold.continuity.status(moved), fold.continuity.superseded({ localDid: alice.did, peerDid: prior.did }), unfinishedWork(fold).notifications]).toEqual([{ status: "verified" }, true, []]);
    expect(await completeNotification(alice.runtime, alice.keys, rotationEventId, options)).toEqual({ effectType: ROTATION_NOTIFICATION_EFFECT, outcome: "none", because: "the peer has replaced its DID" });
    expect(await privateAddress(alice.runtime, alice.keys, new LiveInput(moved), options)).toEqual({ outcome: "reused", decision: rotation.decision });
    fold = await foldOf(alice);
    expect([fold.set.of("did.rotationSelected").length, fold.routes.dids.size, wire.posts.length]).toEqual([1, 2, 0]);
    expect(fold.continuity.head({ localDid: alice.did, peerDid: prior.did })).toEqual({ localDid: (await successorOf(alice, rotation)).did, peerDid: bob.did });
    await closeAll(alice, bob);
  });
});
