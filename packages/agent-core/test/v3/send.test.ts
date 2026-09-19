import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_MESSAGE_TYPE,
  InvalidDidDocument,
  InvalidIdentifier,
  PLAINTEXT_TYP,
  PURE_ACK_EFFECT,
  automaticMessageId,
  channelOf,
  compareChannels,
  didKeyName,
  effectKey,
  inboundMessageId,
  intentOfOutbound,
  objectReader,
  readPlaintext,
  readStoredDocument,
  responseChannel,
  scanVault,
  signFromPrior,
  unfinishedWork,
  vaultDraft,
  type Channel,
  type ContactId,
  type Did,
  type DidId,
  type EventReference,
  type MessageId,
  type PublicKey,
  type ReceiptOrdinal,
  type VaultFold,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { AmbiguousTarget, EntityConflict, NoTarget, UnknownEntity, Unusable, authorizedKeys, automaticDraft, commitResolution, createDid, resolve, retireDid, send, type Content } from "../../src/v3/index.js";
import { directParty, type DirectParty } from "./helpers.js";

const ALICE = "019b0000-0000-7000-8000-00000000000b" as DidId;
const ALICE_NEXT = "019b0000-0000-7000-8000-00000000000c" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const CONTACT = "019b0000-0000-7000-8000-000000000201" as ContactId;
const OTHER = "019b0000-0000-7000-8000-000000000202" as ContactId;

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

async function parties(): Promise<{ alice: DirectParty; bob: DirectParty; carol: DirectParty; toBob: Channel; toCarol: Channel }> {
  const alice = await directParty(1, "https://alice.example/didcomm", ALICE);
  const bob = await directParty(2, "https://bob.example/didcomm", BOB);
  const carol = await directParty(3, "https://carol.example/didcomm", CAROL);
  return { alice, bob, carol, toBob: channelOf(alice.did, bob.did), toCarol: channelOf(alice.did, carol.did) };
}

async function closeAll(...parties: DirectParty[]): Promise<void> {
  for (const party of parties) await party.runtime.close();
}

const fold = (party: DirectParty): Promise<VaultFold> => scanVault(party.runtime.vault, party.keys);

async function contact(party: DirectParty, contactId: ContactId, channels: Channel[]): Promise<void> {
  await party.runtime.vault.commit([], [vaultDraft("contact.created", { contactId, because: "user" }), vaultDraft("contact.channelsSet", { contactId, channels })]);
}

/** Bob's message received at Alice's DID `at`: his document pinned, the body stored, the observation committed — a complete witness of him writing to exactly that address. */
async function received(alice: DirectParty, bob: DirectParty, wire: string, plaintext: Record<string, unknown>, at: { didId: DidId; did: Did } = { didId: ALICE, did: alice.did }): Promise<EventReference<"message.in">> {
  const outcome = await resolve(bob.longFormDid, () => null);
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  const [peerPublicKey] = authorizedKeys(outcome.resolution, "keyAgreement").values();
  const resolved = await commitResolution(alice.runtime, { resolution: outcome.resolution, localKeyName: didKeyName(at.didId, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
  const read = readPlaintext({ typ: PLAINTEXT_TYP, id: wire, from: bob.longFormDid, to: [at.did], ...plaintext });
  const [event] = await alice.runtime.vault.commit(
    [{ cid: read.stored.bodyCid, source: read.stored.bytes }],
    [
      vaultDraft("message.in", {
        messageId: inboundMessageId(bob.did, at.did, wire as WireMessageId),
        wireMessageId: wire as WireMessageId,
        receiptOrdinal: "1" as ReceiptOrdinal,
        intentHash: read.intentHash,
        plaintextHash: read.plaintextHash,
        localKeyName: didKeyName(at.didId, "key-agreement"),
        msgType: read.intent.type,
        peerResolutionEventId: resolved.eventId as EventReference<"peer.resolved">,
        presentedDid: bob.longFormDid,
        did: bob.did,
        thid: read.intent.thid,
        pthid: read.intent.pthid,
        createdTime: read.intent.createdTime,
        expiresTime: read.intent.expiresTime,
        pleaseAck: read.intent.pleaseAck,
        ack: read.intent.ack,
        headers: read.intent.headers,
        fromPrior: null,
        bodyCid: read.stored.bodyCid,
        attachmentCids: read.stored.attachmentCids,
        bytes: 512,
        receivedVia: { mediationId: null, deliveryId: null },
      }),
    ]
  );
  return event!.eventId as EventReference<"message.in">;
}


/** Alice continues `ALICE` as `ALICE_NEXT` toward `peer`, under the proof her seed signs, once the peer has written to `ALICE`: a verified local replacement. */
async function rotated(alice: DirectParty, peer: DirectParty): Promise<{ next: Did; longFormDid: Did }> {
  await received(alice, peer, `confirm-${ALICE}`, { type: BASIC_MESSAGE, body: { content: "I know this address" } });
  const routeId = (await fold(alice)).routes.dids.get(ALICE)!.created!.boundRouteId;
  const { minted } = await createDid(alice.runtime, alice.keys, routeId, ALICE_NEXT);
  const fromPrior = await signFromPrior(alice.keys, { didId: ALICE, longFormDid: alice.longFormDid }, minted.longFormDid, 1_757_700_000);
  await alice.runtime.vault.commit([], [vaultDraft("did.rotationSelected", { fromDidId: ALICE, peerDid: peer.did, toDidId: ALICE_NEXT, sourceEventId: null, fromPrior })]);
  return { next: minted.did, longFormDid: minted.longFormDid };
}

describe("send to a channel", () => {
  const fetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = () => Promise.reject(new Error("the network is off"));
  });
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  it("commits the objects and the intent in one batch with networking off, the channel canonical and the recipient in the spelling given", async () => {
    const { alice, bob, carol, toBob } = await parties();
    const content: Content = {
      ...HELLO,
      attachments: [
        { id: "a1", media_type: "text/plain", data: { base64: "aGVsbG8" } },
        { id: "a2", data: { json: { b: 2, a: 1 } } },
        { id: "a3", data: { links: ["https://files.example/x"], hash: "zQm1" } },
      ],
      thid: "thread-1",
      createdTime: 1_000,
      expiresTime: 2_000,
      pleaseAck: [""],
      headers: { lang: "en" },
    };
    const sent = await send(alice.runtime, alice.keys, { channel: { localDid: alice.longFormDid, peerDid: bob.longFormDid } }, content, { messageId: MESSAGE });
    expect(sent).toMatchObject({ messageId: MESSAGE, channel: toBob, senderDidId: ALICE, existed: false });
    const { data } = sent.intent;
    expect(data).toMatchObject({ messageId: MESSAGE, senderDidId: ALICE, recipientDid: bob.longFormDid, msgType: BASIC_MESSAGE, thid: "thread-1", pthid: null, createdTime: 1_000, expiresTime: 2_000, pleaseAck: [""], ack: [], headers: { lang: "en" } });
    expect([data.executionId, data.effectType, data.effectKey, data.sourceEventId, data.rotationEventId]).toEqual([null, null, null, null, null]);
    expect(data.attachmentCids).toHaveLength(2);
    expect(sent.intent.roots).toEqual([data.bodyCid, ...data.attachmentCids]);

    const f = await fold(alice);
    for (const root of sent.intent.roots) expect(await alice.runtime.vault.objects.has(root)).toBe(true);
    const outbound = f.outbound.outbounds.get(MESSAGE)!;
    expect(outbound.channel).toEqual(toBob);
    expect(outbound.outcome).toEqual({ status: "queued" });
    expect(outbound.work).toEqual({ kind: "prepare" });
    expect(outbound.effect).toEqual({ status: "complete" });
    expect(unfinishedWork(f).outbounds.map((o) => o.messageId)).toEqual([MESSAGE]);
    expect(f.views.channel(toBob).outbound.map((o) => o.messageId)).toEqual([MESSAGE]);

    const read = objectReader(alice.runtime.vault.objects);
    const document = readStoredDocument(JSON.parse(new TextDecoder().decode((await read(data.bodyCid)) as Uint8Array)));
    expect(document.attachments.map((attachment) => attachment.data.kind)).toEqual(["base64", "json", "links"]);
    for (const cid of data.attachmentCids) expect(await read(cid)).toBeInstanceOf(Uint8Array);
    expect(intentOfOutbound(data, document).document).toEqual(document);
    expect(readPlaintext({ typ: PLAINTEXT_TYP, id: MESSAGE, type: BASIC_MESSAGE, from: alice.longFormDid, to: [bob.longFormDid], thid: "thread-1", created_time: 1_000, expires_time: 2_000, please_ack: [""], lang: "en", body: document.body, attachments: content.attachments!.map((a) => ({ ...a })) }).intentHash).toBe(data.intentHash);

    const short = await send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: SECOND });
    expect(short.intent.data.recipientDid).toBe(bob.longFormDid);
    const plain = await send(alice.runtime, alice.keys, { channel: toBob }, HELLO);
    expect(plain.intent.data.recipientDid).toBe(bob.did);
    expect((await fold(alice)).set.of("message.out")).toHaveLength(3);
    await closeAll(alice, bob, carol);
  });

  it("the same message ID with the same target and content is returned, not repeated; another intent or target under it is refused", async () => {
    const { alice, bob, carol, toBob, toCarol } = await parties();
    const sent = await send(alice.runtime, alice.keys, { channel: toBob }, HELLO, { messageId: MESSAGE });
    const again = await send(alice.runtime, alice.keys, { channel: { localDid: alice.longFormDid, peerDid: bob.longFormDid } }, HELLO, { messageId: MESSAGE });
    expect(again.existed).toBe(true);
    expect(again.intent.eventId).toBe(sent.intent.eventId);
    await expect(send(alice.runtime, alice.keys, { channel: toBob }, { ...HELLO, body: { content: "other" } }, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    await expect(send(alice.runtime, alice.keys, { channel: toBob, recipientDid: bob.longFormDid }, HELLO, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    await expect(send(alice.runtime, alice.keys, { channel: toCarol }, HELLO, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    await contact(alice, CONTACT, [toCarol]);
    await expect(send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    await contact(alice, OTHER, [toBob]);
    expect((await send(alice.runtime, alice.keys, { contactId: OTHER }, HELLO, { messageId: MESSAGE })).existed).toBe(true);
    expect((await fold(alice)).set.of("message.out")).toHaveLength(1);
    await closeAll(alice, bob, carol);
  });

  it("refuses a channel whose local DID is not ours or not live, a denied pair, a recipient that is another DID, and a pair of one DID", async () => {
    const { alice, bob, carol, toBob } = await parties();
    await expect(send(alice.runtime, alice.keys, { channel: channelOf(bob.did, alice.did) }, HELLO)).rejects.toBeInstanceOf(Unusable);
    await expect(send(alice.runtime, alice.keys, { channel: toBob, recipientDid: carol.longFormDid }, HELLO)).rejects.toBeInstanceOf(Unusable);
    await expect(send(alice.runtime, alice.keys, { channel: toBob, recipientDid: "not a did" }, HELLO)).rejects.toBeInstanceOf(InvalidDidDocument);
    await expect(send(alice.runtime, alice.keys, { channel: { localDid: alice.did, peerDid: alice.did } }, HELLO)).rejects.toBeInstanceOf(InvalidIdentifier);
    await alice.runtime.vault.commit([], [vaultDraft("channel.blocked", { localDid: alice.did, peerDid: carol.did, includeSuccessors: false })]);
    await expect(send(alice.runtime, alice.keys, { channel: channelOf(alice.did, carol.did) }, HELLO)).rejects.toThrow(/denied/);
    await retireDid(alice.runtime, alice.keys, ALICE, "user");
    await expect(send(alice.runtime, alice.keys, { channel: toBob }, HELLO)).rejects.toThrow(/retired/);
    expect((await fold(alice)).set.of("message.out")).toEqual([]);
    await closeAll(alice, bob, carol);
  });

  it("a channel a verified replacement moved on from takes a send only as an explicit pre-rotation choice; the successor takes it by default, and the old intent stays where it was", async () => {
    const { alice, bob, carol, toBob } = await parties();
    const before = await send(alice.runtime, alice.keys, { channel: toBob }, HELLO, { messageId: MESSAGE });
    const { next } = await rotated(alice, bob);
    const f = await fold(alice);
    expect(f.continuity.head(toBob)).toEqual(channelOf(next, bob.did));
    expect(f.outbound.outbounds.get(MESSAGE)?.channel).toEqual(toBob);
    await expect(send(alice.runtime, alice.keys, { channel: toBob }, HELLO)).rejects.toThrow(/replaced by/);
    const explicit = await send(alice.runtime, alice.keys, { channel: toBob, preRotation: true }, HELLO);
    expect(explicit.channel).toEqual(toBob);
    const successor = await send(alice.runtime, alice.keys, { channel: channelOf(next, bob.did) }, HELLO);
    expect(successor).toMatchObject({ senderDidId: ALICE_NEXT, channel: channelOf(next, bob.did) });
    expect((await send(alice.runtime, alice.keys, { channel: toBob }, HELLO, { messageId: MESSAGE })).intent.eventId).toBe(before.intent.eventId);
    await closeAll(alice, bob, carol);
  });
});

describe("send to a contact", () => {
  it("goes to the one head the selected channels lead to, follows a verified replacement, and leaves several heads to the caller unless the preference picks one", async () => {
    const { alice, bob, carol, toBob, toCarol } = await parties();
    await contact(alice, CONTACT, [toBob]);
    const sent = await send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO);
    expect(sent.channel).toEqual(toBob);
    const { next } = await rotated(alice, bob);
    expect((await send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).channel).toEqual(channelOf(next, bob.did));

    await alice.runtime.vault.commit([], [vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [toBob, toCarol] })]);
    const ambiguous = await send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO).catch((err: unknown) => err);
    expect(ambiguous).toBeInstanceOf(AmbiguousTarget);
    expect((ambiguous as AmbiguousTarget).channels).toEqual([channelOf(next, bob.did), toCarol].sort(compareChannels));
    expect((ambiguous as AmbiguousTarget).preferenceMatchesNone).toBe(false);

    await alice.runtime.vault.commit([], [vaultDraft("contact.useDid", { contactId: CONTACT, didId: ALICE_NEXT, because: "test" })]);
    expect((await send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).channel).toEqual(channelOf(next, bob.did));
    await alice.runtime.vault.commit([], [vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [toCarol] })]);
    const none = await send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO).catch((err: unknown) => err);
    expect(none).toBeInstanceOf(AmbiguousTarget);
    expect((none as AmbiguousTarget)).toMatchObject({ channels: [toCarol], preferenceMatchesNone: true });
    await closeAll(alice, bob, carol);
  });

  it("refuses a contact that is unknown, deleted, selects nothing, or whose heads all take no send", async () => {
    const { alice, bob, carol, toBob } = await parties();
    await expect(send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(UnknownEntity);
    await contact(alice, CONTACT, []);
    await expect(send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(NoTarget);
    await alice.runtime.vault.commit([], [vaultDraft("contact.channelsSet", { contactId: CONTACT, channels: [toBob] }), vaultDraft("channel.blocked", { localDid: alice.did, peerDid: bob.did, includeSuccessors: true })]);
    await expect(send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(NoTarget);
    await alice.runtime.vault.commit([], [vaultDraft("contact.deleted", { contactId: CONTACT })]);
    await expect(send(alice.runtime, alice.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(Unusable);
    expect((await fold(alice)).set.of("message.out")).toEqual([]);
    await closeAll(alice, bob, carol);
  });
});

describe("automatic effects", () => {
  it("drafts the intent under the ID its tuple derives, in the response channel, and finds the one already recorded", async () => {
    const { alice, bob, carol, toBob } = await parties();
    const sourceEventId = await received(alice, bob, "wire-1", { type: BASIC_MESSAGE, body: { content: "hi" }, please_ack: [""], created_time: 1_000 });
    let f = await fold(alice);
    const execution = f.inbound.ofSource(sourceEventId)!;
    expect(execution.status).toEqual({ status: "complete" });
    const source = f.channels.sources.get(sourceEventId)!;
    expect(responseChannel(f, execution)).toEqual({ status: "selected", channel: toBob });
    expect(unfinishedWork(f).responses.map((r) => r.effectType)).toEqual([PURE_ACK_EFFECT]);

    const effect = { execution, source, effectType: PURE_ACK_EFFECT, channel: toBob };
    const drafted = automaticDraft(f, effect, { type: EMPTY_MESSAGE_TYPE, body: {}, thid: "wire-1", createdTime: 1_000, ack: ["wire-1"] });
    const key = effectKey(execution.id, PURE_ACK_EFFECT);
    expect(drafted).toMatchObject({ executionId: execution.id, effectType: PURE_ACK_EFFECT, effectKey: key, messageId: automaticMessageId(key), existing: null });
    expect(drafted.draft.data).toMatchObject({ messageId: automaticMessageId(key), senderDidId: ALICE, recipientDid: bob.did, msgType: EMPTY_MESSAGE_TYPE, thid: "wire-1", pthid: null, createdTime: 1_000, expiresTime: null, pleaseAck: null, ack: ["wire-1"], executionId: execution.id, effectType: PURE_ACK_EFFECT, effectKey: key, sourceEventId, rotationEventId: null });
    expect(drafted.objects.map((object) => object.cid)).toEqual([drafted.draft.data.bodyCid]);

    await alice.runtime.vault.commit(drafted.objects, [drafted.draft]);
    f = await fold(alice);
    const outbound = f.outbound.outbounds.get(drafted.messageId)!;
    expect(outbound.intent.status).toBe("consistent");
    expect(outbound.effect).toEqual({ status: "complete" });
    expect(outbound.channel).toEqual(toBob);
    expect(outbound.work).toEqual({ kind: "prepare" });
    expect(unfinishedWork(f).responses).toEqual([]);
    const again = automaticDraft(f, { ...effect, execution: f.inbound.ofSource(sourceEventId)!, source: f.channels.sources.get(sourceEventId)! }, { type: EMPTY_MESSAGE_TYPE, body: {}, thid: "wire-1", createdTime: 1_000, ack: ["wire-1"] });
    expect(again.existing?.messageId).toBe(drafted.messageId);
    expect(again.draft.data).toEqual(drafted.draft.data);
    await closeAll(alice, bob, carol);
  });

  it("refuses a response channel whose local DID cannot send", async () => {
    const { alice, bob, carol, toBob } = await parties();
    const sourceEventId = await received(alice, bob, "wire-2", { type: BASIC_MESSAGE, body: { content: "hi" }, please_ack: [""] });
    await retireDid(alice.runtime, alice.keys, ALICE, "user");
    const f = await fold(alice);
    const execution = f.inbound.ofSource(sourceEventId)!;
    expect(responseChannel(f, execution).status).toBe("none");
    expect(() => automaticDraft(f, { execution, source: f.channels.sources.get(sourceEventId)!, effectType: PURE_ACK_EFFECT, channel: toBob }, { type: EMPTY_MESSAGE_TYPE, body: {}, ack: ["wire-2"] })).toThrow(Unusable);
    await closeAll(alice, bob, carol);
  });
});
