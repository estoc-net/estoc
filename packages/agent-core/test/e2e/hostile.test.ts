import { SignJWT, importJWK } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { resolveDIDCommDoc, type DIDDoc } from "@estoc/did-peer";
import { didKeyName, type Did, type DidId, type MessageId, type VaultFold } from "@estoc/vault";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import type { IMessage } from "../../src/protocol/didcomm.js";
import { FORWARD } from "../../src/protocol/spec.js";
import { Unusable } from "../../src/index.js";
import type { FakeMediator } from "../fake-mediator.js";
import { newMediator, peerSealer, sealed, type DirectParty, type Sealer } from "../helpers.js";
import { LONG, channelOf, foldOf, forwarded, run, stopAll, until, type Running } from "./running.js";

const ALICE = "019b0000-0000-7000-8000-00000000000a" as DidId;
const BOB = "019b0000-0000-7000-8000-0000000000b0" as DidId;
const CAROL = "019b0000-0000-7000-8000-0000000000c0" as DidId;
const MALLORY = "019b0000-0000-7000-8000-0000000000d0" as DidId;
const FIRST = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const IAT = 1_790_000_000;

afterEach(stopAll);

const hello = (content: string) => ({ type: BASIC_MESSAGE, body: { content } });

const forwardsSeen = (mediator: FakeMediator): number => mediator.seenTypes.filter((type) => type === FORWARD).length;

const queuedFor = (mediator: FakeMediator, party: Running): number => mediator.queues.get(party.party.created.data.me.did)?.length ?? 0;

const didOf = (fold: VaultFold, didId: DidId): Did => fold.routes.dids.get(didId)!.created!.did;

const sealerOf = (running: Running, as?: Did): Promise<Sealer> => peerSealer(running.party as unknown as DirectParty, as);

/**
 * Mallory sealing as herself under a proof that says Bob's DID rotated
 * to hers: signed with her own key under the name of Bob's, and sealed
 * against a resolver that answers Bob's DID with her document, as a
 * sender is free to arrange on its side of the wire.
 */
async function claimingToSucceed(mallory: Running, bob: Running): Promise<{ sealer: Sealer; proof: string }> {
  const honest = await sealerOf(mallory);
  const own = JSON.stringify(await resolveDIDCommDoc(mallory.party.longFormDid));
  const asBob = JSON.parse(own.replaceAll(mallory.party.longFormDid, bob.party.longFormDid)) as DIDDoc;
  const method = asBob.authentication[0]!;
  const kid = method.startsWith("#") ? `${bob.party.longFormDid}${method}` : method;
  const key = await mallory.keys.signing(didKeyName(MALLORY, "authentication"));
  const proof = await new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
    .setIssuer(bob.party.longFormDid)
    .setSubject(mallory.party.longFormDid)
    .setIssuedAt(IAT)
    .sign(await importJWK(key.privateJwk(), "EdDSA"));
  return { proof, sealer: { ...honest, resolver: { resolve: async (did: string) => (did === bob.party.longFormDid ? asBob : honest.resolver.resolve(did)) } } };
}

describe("what a stranger hands the mediator", () => {
  it("is taken off it whatever it is, and changes nothing it has no standing to change: an envelope for someone else, one from an unknown short form and one asking for a return route are discarded with a reason, and a claim to succeed the peer is recorded as an invalid proof that moves no channel and earns no reply", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    const carol = await run(mediator, 3, CAROL, { privateAddresses: false });
    const mallory = await run(mediator, 4, MALLORY, { privateAddresses: false });
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
    await until("alice has bob's message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
    await until("bob has the answer", () => bob.inbounds.length === 1);
    const forwards = forwardsSeen(mediator);
    const asHerself = await sealerOf(mallory);

    await forwarded(mediator, a0, await sealed(asHerself, carol.party.longFormDid));
    await forwarded(mediator, a0, await sealed(await sealerOf(mallory, mallory.party.did), alice.party.longFormDid));
    await forwarded(mediator, a0, await sealed(asHerself, alice.party.longFormDid, { return_route: "all" } as Partial<IMessage>));
    await until("alice has ended the three", () => alice.inbounds.length === 4);
    expect(alice.inbounds.slice(1).map(({ received, after, reacted }) => [received.outcome, after, reacted])).toEqual([
      ["terminal", null, null],
      ["terminal", null, null],
      ["terminal", null, null],
    ]);
    expect(alice.agent.discardedDeliveries().map(({ reason }) => reason)).toEqual([
      expect.stringContaining("local recipient material is unavailable"),
      expect.stringContaining(`sender material is unavailable for ${mallory.party.did}`),
      expect.stringContaining("return_route"),
    ]);
    expect((await foldOf(alice)).set.of("message.in")).toHaveLength(1);

    const { sealer, proof } = await claimingToSucceed(mallory, bob);
    await forwarded(mediator, a0, await sealed(sealer, alice.party.longFormDid, { from_prior: proof, please_ack: [""] } as Partial<IMessage>));
    await until("alice has recorded the claim", () => alice.inbounds.length === 5);
    expect(alice.inbounds[4]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "invalid" } }, reacted: { effects: [] } });
    expect(queuedFor(mediator, alice)).toBe(0);
    expect(forwardsSeen(mediator)).toBe(forwards + 4);

    const fold = await foldOf(alice);
    expect(fold.continuity.model.history(channelOf(a0, b0)).links).toEqual([]);
    expect(fold.continuity.conflicts).toEqual([]);
    expect(fold.continuity.head(channelOf(a0, b0))).toEqual(channelOf(a0, b0));
    expect(fold.outbound.outbounds.size).toBe(1);
    const claimed = await (await alice.agent.records()).channel(channelOf(a0, mallory.party.did));
    expect(claimed.messages).toMatchObject([{ direction: "in", verification: { status: "invalid" }, input: { status: "pending" }, manualAction: "none" }]);
    expect((await alice.agent.pending()).missingResponses).toEqual([]);
    await expect(alice.agent.send({ channel: channelOf(a0, mallory.party.did) }, hello("who are you"))).resolves.toMatchObject({ dispatched: { outcome: "submitted" } });
  });
});

describe("a peer that writes from the address it rotated away from", () => {
  it("is recorded and answered with nothing, and the channel it moved to stays the head", { timeout: LONG }, async () => {
    const mediator = await newMediator();
    const alice = await run(mediator, 1, ALICE, { privateAddresses: false });
    const bob = await run(mediator, 2, BOB, { privateAddresses: false });
    const a0 = alice.party.did;
    const b0 = bob.party.did;
    await bob.agent.send({ channel: channelOf(b0, a0), recipientDid: alice.party.longFormDid }, hello("hello"), { messageId: FIRST });
    await until("alice has the first message", () => alice.inbounds.length === 1);
    await alice.agent.send({ channel: channelOf(a0, b0) }, hello("hello yourself"), { messageId: SECOND });
    await until("bob has the answer", () => bob.inbounds.length === 1);
    const rotated = await bob.agent.manual.rotate({ localDidId: BOB, peerDid: a0 });
    const b1 = didOf(await foldOf(bob), rotated.successor);
    await until("alice has the notification", () => alice.inbounds.length === 2);
    await until("bob has the acknowledgement", () => bob.inbounds.length === 2);

    await expect(bob.agent.send({ channel: channelOf(b0, a0) }, hello("from the old address"))).rejects.toBeInstanceOf(Unusable);
    const forwards = forwardsSeen(mediator);
    const old = await bob.agent.send({ channel: channelOf(b0, a0), preRotation: true }, { ...hello("from the old address"), pleaseAck: [""] }, { messageId: THIRD });
    expect(old.dispatched).toMatchObject({ outcome: "submitted" });
    await until("alice has the message from the old address", () => alice.inbounds.length === 3);
    expect(alice.inbounds[2]).toMatchObject({ received: { outcome: "received", live: true }, after: { proof: { status: "not-present" }, disposition: { status: "ignored-superseded" } }, reacted: { because: "the input is not established: no observation of the input is admitted", effects: [] } });
    expect(forwardsSeen(mediator)).toBe(forwards + 1);
    const fold = await foldOf(alice);
    expect(fold.continuity.head(channelOf(a0, b0))).toEqual(channelOf(a0, b1));
    expect((await alice.agent.pending()).missingResponses).toEqual([]);
    expect((await foldOf(bob)).outbound.outbounds.get(THIRD)).toMatchObject({ outcome: { status: "submitted" }, acknowledged: false });
  });
});
