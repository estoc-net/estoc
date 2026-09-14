import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { longToShort } from "@estoc/did-peer";
import { MemoryVault } from "@estoc/event-store/v3";
import {
  InvalidDidDocument,
  didKeyName,
  intentOfOutbound,
  objectReader,
  readPlaintext,
  readStoredDocument,
  relationshipId,
  scanVault,
  unfinishedWork,
  vaultDraft,
  wirePlaintext,
  type Cid,
  type ContactId,
  type Did,
  type DidId,
  type MessageId,
  type PublicKey,
  type RouteId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { AmbiguousTarget, EntityConflict, UnknownEntity, Unusable, authorizedKeys, commitResolution, configureRoute, createDid, resolve, retireDid, send, type Content } from "../../src/v3/index.js";
import { freshVault, json, newMediator, webFetch, webIdentity, type Fresh } from "./helpers.js";

const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const FRESH = "019b0000-0000-7000-8000-00000000000c" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const CONTACT = "019b0000-0000-7000-8000-000000000201" as ContactId;
const OTHER = "019b0000-0000-7000-8000-000000000202" as ContactId;
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

/** Alice: a vault with one communication DID on a direct route. */
async function alice(): Promise<Fresh & { did: Did }> {
  const fresh = await freshVault();
  await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint: "https://alice.example/didcomm" }, ROUTE);
  const { minted } = await createDid(fresh.runtime, fresh.keys, ROUTE, DID);
  return { ...fresh, did: minted.did };
}

async function contact(a: Fresh, contactId: ContactId, peerDids: string[] = []): Promise<void> {
  await a.runtime.vault.commit([], [vaultDraft("contact.created", { contactId, because: "user" }), ...peerDids.map((did) => vaultDraft("contact.peerDidAdded", { contactId, did: did as Did, because: "test" }))]);
}

/** Alice's relationship with Bob bound: his document resolved from inside the test, pinned, and the binding committed. */
async function boundToBob(a: Fresh & { did: Did }): Promise<{ relationshipId: ReturnType<typeof relationshipId>; peerDid: Did }> {
  const bob = await webIdentity(BOB);
  const outcome = await resolve(BOB, () => null, { fetch: webFetch({ [BOB_URL]: () => json(bob.document) }).fetch });
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  const [peerPublicKey] = authorizedKeys(outcome.resolution, "keyAgreement").values();
  const resolved = await commitResolution(a.runtime, { resolution: outcome.resolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: peerPublicKey as PublicKey });
  const R = relationshipId(a.did, BOB as Did);
  await a.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: R, localDidId: DID, peerResolutionEventId: resolved.eventId as never })]);
  return { relationshipId: R, peerDid: BOB as Did };
}

describe("send to an address", () => {
  const fetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = () => Promise.reject(new Error("the network is off"));
  });
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  it("a new pair: one commit of the objects, the intent and the sender minted for it, with networking off; the birth freezes the exact peer spelling and the pair again freezes the same selection", async () => {
    const a = await alice();
    const bob = await newMediator(201);
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
    const sent = await send(a.runtime, a.keys, { peerDid: bob.did, sender: { fresh: ROUTE, didId: FRESH } }, content, { messageId: MESSAGE });
    expect(sent.existed).toBe(false);
    expect(sent.created?.data).toMatchObject({ didId: FRESH, boundRouteId: ROUTE });
    expect(sent.assigned).toBeNull();
    expect(sent.relationshipId).toBe(relationshipId(sent.created!.data.did, longToShort(bob.did) as Did));
    expect(sent.birth).toEqual({ localDidId: FRESH, peerDid: bob.did });
    const { data } = sent.intent;
    expect(data).toMatchObject({ messageId: MESSAGE, relationshipId: sent.relationshipId, birth: sent.birth, msgType: BASIC_MESSAGE, thid: "thread-1", pthid: null, createdTime: 1_000, expiresTime: 2_000, pleaseAck: [""], ack: [], headers: { lang: "en" } });
    expect(data.attachmentCids).toHaveLength(2);
    expect(sent.intent.roots).toEqual([data.bodyCid, ...data.attachmentCids]);
    expect([data.executionId, data.handlerId, data.effectKind, data.ordinal, data.effectKey]).toEqual([null, null, null, null, null]);

    const fold = await scanVault(a.runtime.vault, a.keys);
    for (const root of sent.intent.roots) expect(await a.runtime.vault.objects.has(root)).toBe(true);
    expect(fold.set.of("did.created").map((event) => event.data.didId)).toEqual([DID, FRESH]);
    expect(fold.routes.dids.get(FRESH)?.live).toBe(true);
    expect(fold.outbound.outbounds.get(MESSAGE)?.outcome).toBe("queued");
    expect(unfinishedWork(fold).births).toEqual([{ messageId: MESSAGE, relationshipId: sent.relationshipId, birth: sent.birth }]);
    expect(fold.held.has(data.bodyCid)).toBe(true);

    const read = objectReader(a.runtime.vault.objects);
    const document = readStoredDocument(JSON.parse(new TextDecoder().decode((await read(data.bodyCid)) as Uint8Array)));
    expect(document.attachments.map((attachment) => attachment.data.kind)).toEqual(["base64", "json", "links"]);
    const payloads = new Map<Cid, Uint8Array>();
    for (const cid of data.attachmentCids) payloads.set(cid, (await read(cid)) as Uint8Array);
    const plaintext = wirePlaintext(intentOfOutbound(data, document), { from: sent.created!.data.longFormDid, to: [bob.did as Did], fromPrior: null }, (root) => payloads.get(root) as Uint8Array);
    expect(readPlaintext(plaintext).intentHash).toBe(data.intentHash);
    expect(plaintext).toMatchObject({ id: MESSAGE, thid: "thread-1", created_time: 1_000, expires_time: 2_000, please_ack: [""], lang: "en" });
    expect(plaintext).not.toHaveProperty("ack");
    expect(plaintext).not.toHaveProperty("pthid");

    const again = await send(a.runtime, a.keys, { peerDid: longToShort(bob.did), sender: { didId: FRESH } }, HELLO);
    expect(again.created).toBeNull();
    expect(again.relationshipId).toBe(sent.relationshipId);
    expect(again.birth).toEqual(sent.birth);
    expect((await scanVault(a.runtime.vault, a.keys)).set.of("message.out")).toHaveLength(2);
    await a.runtime.close();
  });

  it("the same message ID with the same target and content is returned, not repeated; another intent under it is refused", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    const target = { peerDid: bob.did, sender: { didId: DID } };
    const sent = await send(a.runtime, a.keys, target, HELLO, { messageId: MESSAGE });
    const again = await send(a.runtime, a.keys, target, HELLO, { messageId: MESSAGE });
    expect(again.existed).toBe(true);
    expect(again.intent.eventId).toBe(sent.intent.eventId);
    await expect(send(a.runtime, a.keys, target, { ...HELLO, body: { content: "other" } }, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: { fresh: ROUTE } }, HELLO, { messageId: MESSAGE })).rejects.toBeInstanceOf(EntityConflict);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("message.out")).toHaveLength(1);
    expect(fold.set.of("did.created")).toHaveLength(1);
    await a.runtime.close();
  });

  it("an intent whose objects are missing goes in again with them", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    const target = { peerDid: bob.did, sender: { didId: DID } };
    const sent = await send(a.runtime, a.keys, target, HELLO, { messageId: MESSAGE });
    const copy = new MemoryVault({ metadata: a.runtime.metadata });
    const set = (await scanVault(a.runtime.vault, a.keys)).set;
    await copy.ingest([...set.of("route.configured"), ...set.of("did.created"), sent.intent]);
    expect(await copy.vault.objects.has(sent.intent.data.bodyCid)).toBe(false);
    const repaired = await send(copy, a.keys, target, HELLO, { messageId: MESSAGE });
    expect(repaired.existed).toBe(false);
    expect(repaired.intent.eventId).not.toBe(sent.intent.eventId);
    expect(await copy.vault.objects.has(sent.intent.data.bodyCid)).toBe(true);
    const fold = await scanVault(copy.vault, a.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)?.conflict).toBe(false);
    expect(fold.outbound.outbounds.get(MESSAGE)?.intentEventIds).toHaveLength(2);
    await a.runtime.close();
  });

  it("a bound pair is written in at its relationship with no birth; the pair claimed by the histories is found under either spelling", async () => {
    const a = await alice();
    const { relationshipId: R } = await boundToBob(a);
    const sent = await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO);
    expect(sent.relationshipId).toBe(R);
    expect(sent.birth).toBeNull();
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(sent.messageId)?.work).toEqual({ kind: "prepare" });
    expect(unfinishedWork(fold).births).toEqual([]);
    await a.runtime.close();
  });

  it("assigns the relationship to the contact named, once; a relationship assigned elsewhere is refused", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    await contact(a, CONTACT);
    await contact(a, OTHER);
    const sent = await send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: DID }, contactId: CONTACT }, HELLO);
    expect(sent.assigned?.data).toEqual({ relationshipId: sent.relationshipId, contactId: CONTACT });
    const again = await send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: DID }, contactId: CONTACT }, HELLO);
    expect(again.assigned).toBeNull();
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: DID }, contactId: OTHER }, HELLO)).rejects.toBeInstanceOf(EntityConflict);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("relationship.contactAssigned")).toHaveLength(1);
    expect(fold.contacts.get(CONTACT)?.relationships.map((r) => [r.relationshipId, r.standing])).toEqual([[sent.relationshipId, "pending"]]);
    await a.runtime.close();
  });

  it("refuses, writing nothing: a sender that is retired or unknown, a peer that is not a DID, a reserved header, an expiry before creation, a contact that is unknown or deleted", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    const from = { didId: DID };
    await contact(a, OTHER);
    await a.runtime.vault.commit([], [vaultDraft("contact.deleted", { contactId: OTHER })]);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: FRESH } }, HELLO)).rejects.toBeInstanceOf(UnknownEntity);
    await expect(send(a.runtime, a.keys, { peerDid: "not a did", sender: from }, HELLO)).rejects.toBeInstanceOf(InvalidDidDocument);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from }, { ...HELLO, headers: { return_route: "all" } })).rejects.toThrow(/return_route/);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from }, { ...HELLO, createdTime: 10, expiresTime: 10 })).rejects.toThrow(/expiresTime/);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from }, { ...HELLO, body: "text" as never })).rejects.toThrow(/body/);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from, contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(UnknownEntity);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from, contactId: OTHER }, HELLO)).rejects.toBeInstanceOf(Unusable);
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: { fresh: "019b0000-0000-7000-8000-0000000000ff" as RouteId } }, HELLO)).rejects.toBeInstanceOf(UnknownEntity);
    await retireDid(a.runtime, a.keys, DID, "test");
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: from }, HELLO)).rejects.toBeInstanceOf(Unusable);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("message.out")).toEqual([]);
    expect(fold.set.of("did.created")).toHaveLength(1);
    await a.runtime.close();
  });

  it("a queued birth whose sender was retired is not written in again", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    await send(a.runtime, a.keys, { peerDid: bob.did, sender: { fresh: ROUTE, didId: FRESH } }, HELLO);
    await retireDid(a.runtime, a.keys, FRESH, "test");
    await expect(send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: FRESH } }, HELLO)).rejects.toBeInstanceOf(Unusable);
    expect((await scanVault(a.runtime.vault, a.keys)).set.of("message.out")).toHaveLength(1);
    await a.runtime.close();
  });
});

describe("send to a contact", () => {
  it("the one relationship the contact may be written in, bound or at its queued birth; several are ambiguous until a preference names one", async () => {
    const a = await alice();
    const bob = await newMediator(201);
    await contact(a, CONTACT);
    await expect(send(a.runtime, a.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(Unusable);
    const first = await send(a.runtime, a.keys, { peerDid: bob.did, sender: { didId: DID }, contactId: CONTACT }, HELLO);
    const queued = await send(a.runtime, a.keys, { contactId: CONTACT }, HELLO);
    expect(queued.relationshipId).toBe(first.relationshipId);
    expect(queued.birth).toEqual(first.birth);
    expect(queued.assigned).toBeNull();

    const { relationshipId: R2 } = await boundToBob(a);
    await a.runtime.vault.commit([], [vaultDraft("relationship.contactAssigned", { relationshipId: R2, contactId: CONTACT })]);
    await expect(send(a.runtime, a.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(AmbiguousTarget);
    await a.runtime.vault.commit([], [vaultDraft("contact.useDid", { contactId: CONTACT, didId: DID, because: "test" })]);
    const preferred = await send(a.runtime, a.keys, { contactId: CONTACT }, HELLO);
    expect(preferred.relationshipId).toBe(R2);
    expect(preferred.birth).toBeNull();
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("message.out")).toHaveLength(3);
    expect(fold.contacts.get(CONTACT)?.writeTo).toEqual([R2]);
    await a.runtime.close();
  });

  it("a contact with one peer DID added and no relationship starts the pair from the sender given, assigned to it", async () => {
    const a = await alice();
    const carol = await newMediator(202);
    await contact(a, CONTACT, [carol.did]);
    await expect(send(a.runtime, a.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(Unusable);
    const sent = await send(a.runtime, a.keys, { contactId: CONTACT, sender: { fresh: ROUTE, didId: FRESH } }, HELLO);
    expect(sent.created?.data.didId).toBe(FRESH);
    expect(sent.birth).toEqual({ localDidId: FRESH, peerDid: carol.did });
    expect(sent.relationshipId).toBe(relationshipId(sent.created!.data.did, longToShort(carol.did) as Did));
    expect(sent.assigned?.data).toEqual({ relationshipId: sent.relationshipId, contactId: CONTACT });
    const next = await send(a.runtime, a.keys, { contactId: CONTACT }, HELLO);
    expect(next.relationshipId).toBe(sent.relationshipId);
    expect(next.created).toBeNull();
    expect(next.assigned).toBeNull();

    await contact(a, OTHER, [carol.did, (await newMediator(203)).did]);
    await expect(send(a.runtime, a.keys, { contactId: OTHER, sender: { fresh: ROUTE } }, HELLO)).rejects.toBeInstanceOf(Unusable);
    await expect(send(a.runtime, a.keys, { contactId: "019b0000-0000-7000-8000-0000000002ff" as ContactId }, HELLO)).rejects.toBeInstanceOf(UnknownEntity);
    await a.runtime.close();
  });

  it("a deleted contact is not written to, in any of its relationships", async () => {
    const a = await alice();
    const { relationshipId: R } = await boundToBob(a);
    await contact(a, CONTACT);
    await a.runtime.vault.commit([], [vaultDraft("relationship.contactAssigned", { relationshipId: R, contactId: CONTACT }), vaultDraft("contact.deleted", { contactId: CONTACT })]);
    await expect(send(a.runtime, a.keys, { contactId: CONTACT }, HELLO)).rejects.toBeInstanceOf(Unusable);
    await expect(send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO)).rejects.toBeInstanceOf(Unusable);
    expect((await scanVault(a.runtime.vault, a.keys)).set.of("message.out")).toEqual([]);
    await a.runtime.close();
  });
});
