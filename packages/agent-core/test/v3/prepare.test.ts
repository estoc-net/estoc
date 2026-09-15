import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toDIDCommDIDDoc, type DIDDoc, type Secret } from "@estoc/did-peer";
import { canonicalize, parseStrict, type JsonObject } from "@estoc/event-store/v3";
import {
  didKeyName,
  inboundMessageId,
  plaintextHash,
  readPlaintext,
  relationshipId,
  scanVault,
  signFromPrior,
  unfinishedWork,
  vaultDraft,
  type Did,
  type DidId,
  type DidUrl,
  type EventReference,
  type MessageId,
  type PublicKey,
  type ReceiptOrdinal,
  type RelationshipId,
  type RouteId,
  type VaultData,
  type VaultEvent,
  type WireMessageId,
} from "@estoc/vault/v3";

import { BASIC_MESSAGE } from "../../src/protocol/basicmessage.js";
import { secretsResolverFor } from "../../src/protocol/didcomm.js";
import { AgentTrace, EXPIRED, Keyring, PEER_KEY_CHANGED, UnknownEntity, authorizedKeys, commitResolution, configureRoute, createDid, pinnedResolver, prepare, prepareAll, resolve, send, type Content, type PrepareOptions, type Prepared, type Resolution } from "../../src/v3/index.js";
import { didcomm, freshVault, json, webFetch, webIdentity, type Fresh, type WebIdentity } from "./helpers.js";

const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const FRESH = "019b0000-0000-7000-8000-00000000000c" as DidId;
const MESSAGE = "019b0000-0000-7000-8000-000000000101" as MessageId;
const SECOND = "019b0000-0000-7000-8000-000000000102" as MessageId;
const THIRD = "019b0000-0000-7000-8000-000000000103" as MessageId;
const FOURTH = "019b0000-0000-7000-8000-000000000104" as MessageId;
const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const NEXT = "did:web:next.example";
const NEXT_URL = "https://next.example/.well-known/did.json";
const IAT = 1_757_700_000;

const HELLO: Content = { type: BASIC_MESSAGE, body: { content: "hello" } };

type Party = Fresh & { did: Did; longFormDid: Did };

/** A vault with one communication DID on a direct route. */
async function party(fill: number, endpoint: string): Promise<Party> {
  const fresh = await freshVault(fill);
  await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint }, ROUTE);
  const { minted } = await createDid(fresh.runtime, fresh.keys, ROUTE, DID);
  return { ...fresh, did: minted.did, longFormDid: minted.longFormDid };
}

const alice = () => party(1, "https://alice.example/didcomm");
const bobVault = () => party(101, "https://bob.example/didcomm");

const options = (over: Partial<PrepareOptions> = {}): PrepareOptions => ({ didcomm, ...over });

/** Bob's document served over the network, and the options that fetch it. */
function serving(bob: WebIdentity): PrepareOptions & { calls: string[] } {
  const web = webFetch({ [BOB_URL]: () => json(bob.document) });
  return { ...options({ fetch: web.fetch }), calls: web.calls };
}

async function webResolution(bob: WebIdentity, url = BOB_URL): Promise<Resolution> {
  const outcome = await resolve(bob.did, () => null, { fetch: webFetch({ [url]: () => json(bob.document) }).fetch });
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

async function peerResolutionOf(did: string): Promise<Resolution> {
  const outcome = await resolve(did, () => null);
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

function keyAgreementKey(resolution: Resolution): PublicKey {
  const [key] = authorizedKeys(resolution, "keyAgreement").values();
  return key as PublicKey;
}

/** Alice's relationship with a peer bound at her DID: the peer's document pinned as the binding's root, as a receipt would. */
async function bound(a: Party, resolution: Resolution): Promise<{ R: RelationshipId; root: VaultEvent<"peer.resolved">; binding: VaultEvent<"relationship.bound"> }> {
  const root = await commitResolution(a.runtime, { resolution, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: keyAgreementKey(resolution) });
  const R = relationshipId(a.did, resolution.did);
  const [binding] = await a.runtime.vault.commit([], [vaultDraft("relationship.bound", { relationshipId: R, localDidId: DID, peerResolutionEventId: root.eventId as EventReference<"peer.resolved"> })]);
  return { R, root, binding: binding as VaultEvent<"relationship.bound"> };
}

/** An authenticated, proof-free observation from the peer at one of Alice's keys, scoped by the binding: what confirms that local address. */
async function confirmedAt(a: Party, R: RelationshipId, localDidId: DidId, resolution: Resolution, binding: VaultEvent<"relationship.bound">, wire: string): Promise<void> {
  const localKeyName = didKeyName(localDidId, "key-agreement");
  const peerPublicKey = keyAgreementKey(resolution);
  const evidence = await commitResolution(a.runtime, { resolution, localKeyName, peerPublicKey });
  const plaintext = { id: wire, type: BASIC_MESSAGE, body: { content: "hi" }, from: resolution.presentedDid, to: [a.did] };
  const read = readPlaintext(plaintext);
  const receipt: VaultData["message.in"] = {
    messageId: inboundMessageId(peerPublicKey, wire as WireMessageId),
    wireMessageId: wire as WireMessageId,
    receiptOrdinal: "1" as ReceiptOrdinal,
    intentHash: read.intentHash,
    plaintextHash: read.plaintextHash,
    localKeyName,
    msgType: BASIC_MESSAGE,
    peerResolutionEventId: evidence.eventId as EventReference<"peer.resolved">,
    relationshipBindingEventId: binding.eventId as EventReference<"relationship.bound">,
    peerTransitionEventId: null,
    presentedDid: resolution.presentedDid,
    did: resolution.did,
    thid: null,
    pthid: null,
    createdTime: null,
    expiresTime: null,
    pleaseAck: null,
    ack: [],
    headers: {},
    fromPrior: null,
    bodyCid: read.stored.bodyCid,
    attachmentCids: [],
    bytes: 100,
    signedBy: null,
    receivedVia: { mediationId: null, deliveryId: null },
  };
  await a.runtime.vault.commit([{ cid: read.stored.bodyCid, source: read.stored.bytes }], [vaultDraft("message.in", receipt)]);
  const fold = await scanVault(a.runtime.vault, a.keys);
  const scope = fold.relationships.observations.get(fold.set.of("message.in").find((event) => event.data.wireMessageId === wire)!.eventId);
  expect(scope).toEqual({ status: "scoped", relationshipId: R });
}

/** The peer's verified continuation from `bob` to `next`, committed as receipt commits it: the carrying receipt at Alice's key with the proof, and the transition it verifies. */
async function continuedTo(a: Party, R: RelationshipId, root: VaultEvent<"peer.resolved">, binding: VaultEvent<"relationship.bound">, bob: WebIdentity, next: WebIdentity, evidence: VaultEvent<"peer.resolved">): Promise<void> {
  const issuer = { resolve: async (did: string): Promise<DIDDoc | null> => (did === bob.did ? toDIDCommDIDDoc(bob.document) : null) };
  const [fromPrior] = await new didcomm.FromPrior({ iss: bob.did, sub: next.did, iat: IAT }).pack(`${bob.did}#auth`, issuer, secretsResolverFor(bob.secrets));
  const localKeyName = didKeyName(DID, "key-agreement");
  const peerPublicKey = evidence.data.peerPublicKey;
  const wire = "continuation-carrier" as WireMessageId;
  const plaintext = { id: wire, type: BASIC_MESSAGE, body: { content: "moved" }, from: next.did, to: [a.did], from_prior: fromPrior };
  const read = readPlaintext(plaintext);
  const messageId = inboundMessageId(peerPublicKey, wire);
  const receipt: VaultData["message.in"] = {
    messageId,
    wireMessageId: wire,
    receiptOrdinal: "1" as ReceiptOrdinal,
    intentHash: read.intentHash,
    plaintextHash: read.plaintextHash,
    localKeyName,
    msgType: BASIC_MESSAGE,
    peerResolutionEventId: evidence.eventId as EventReference<"peer.resolved">,
    relationshipBindingEventId: binding.eventId as EventReference<"relationship.bound">,
    peerTransitionEventId: null,
    presentedDid: next.did as Did,
    did: next.did as Did,
    thid: null,
    pthid: null,
    createdTime: null,
    expiresTime: null,
    pleaseAck: null,
    ack: [],
    headers: {},
    fromPrior,
    bodyCid: read.stored.bodyCid,
    attachmentCids: [],
    bytes: 100,
    signedBy: null,
    receivedVia: { mediationId: null, deliveryId: null },
  };
  const transition: VaultData["relationship.peerTransitioned"] = {
    relationshipId: R,
    localKeyName,
    peerPublicKey,
    fromDid: bob.did as Did,
    presentedFromDid: bob.did as Did,
    toDid: next.did as Did,
    presentedToDid: next.did as Did,
    fromPrior,
    priorResolutionEventId: root.eventId as EventReference<"peer.resolved">,
    peerResolutionEventId: evidence.eventId as EventReference<"peer.resolved">,
    messageId,
  };
  await a.runtime.vault.commit([{ cid: read.stored.bodyCid, source: read.stored.bytes }], [vaultDraft("message.in", receipt), vaultDraft("relationship.peerTransitioned", transition)]);
  const relationship = (await scanVault(a.runtime.vault, a.keys)).relationships.relationships.get(R);
  expect(relationship).toMatchObject({ conflict: false, currentPeerDid: next.did });
}

/** The envelope opened on the peer's side: with the peer's secrets, Alice's documents as she holds them, and the peer's own. */
async function opened(a: Party, packed: string, secrets: Secret[], own: JsonObject[]): Promise<{ plaintext: JsonObject; metadata: Record<string, unknown> }> {
  const fold = await scanVault(a.runtime.vault, a.keys);
  const local = pinnedResolver(fold);
  const resolver = {
    resolve: async (did: string): Promise<DIDDoc | null> => {
      const document = own.find((document) => document["id"] === did);
      return document === undefined ? local.resolve(did) : toDIDCommDIDDoc(document);
    },
  };
  const [msg, metadata] = await didcomm.Message.unpack(packed, resolver, secretsResolverFor(secrets), {});
  return { plaintext: msg.as_value() as JsonObject, metadata: metadata as unknown as Record<string, unknown> };
}

async function envelopeOf(a: Party, prepared: Prepared): Promise<{ packed: string; bytes: Uint8Array }> {
  if (prepared.outcome !== "prepared") throw new Error(`not prepared: ${JSON.stringify(prepared)}`);
  const bytes = (await a.runtime.vault.objects.read(prepared.prepared.data.envelopeCid, 1 << 20)) as Uint8Array;
  return { packed: new TextDecoder().decode(bytes), bytes };
}

describe("prepare to a did:web peer", () => {
  const fetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = () => Promise.reject(new Error("the network is off"));
  });
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  it("a first package: the peer resolved afresh and recorded, the package and its envelope committed in one batch, the envelope opening to the exact plaintext on the peer's side", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    const { R, root } = await bound(a, await webResolution(bob));
    const trace = await AgentTrace.open(a.runtime.local);
    const content: Content = {
      ...HELLO,
      attachments: [
        { id: "a1", media_type: "text/plain", data: { base64: "aGVsbG8" } },
        { id: "a2", data: { json: { b: 2, a: 1 } } },
        { id: "a3", data: { links: ["https://files.example/x"], hash: "zQm1" } },
      ],
      thid: "thread-1",
      createdTime: 1_000,
      pleaseAck: [""],
      headers: { lang: "en" },
    };
    const sent = await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, content, { messageId: MESSAGE });
    const web = serving(bob);
    const result = await prepare(a.runtime, a.keys, MESSAGE, { ...web, trace });
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(web.calls).toEqual([BOB_URL]);
    expect(result.bound).toBeNull();
    expect(result.retired).toEqual([]);
    expect(result.resolved).not.toBeNull();
    expect(result.resolved!.eventId).not.toBe(root.eventId);
    expect(result.resolved!.data).toEqual(root.data);
    const { data } = result.prepared;
    expect(data).toMatchObject({ messageId: MESSAGE, packageId: result.packageId, senderDidId: DID, localKeyName: didKeyName(DID, "key-agreement"), recipientDid: BOB, peerResolutionEventId: result.resolved!.eventId, fromPrior: null, intentHash: sent.intent.data.intentHash });
    expect(result.prepared.roots).toEqual([data.envelopeCid]);

    const fold = await scanVault(a.runtime.vault, a.keys);
    const outbound = fold.outbound.outbounds.get(MESSAGE)!;
    expect(outbound.outcome).toBe("prepared");
    expect(outbound.work).toEqual({ kind: "submit", packageIds: [result.packageId] });
    expect(outbound.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
    expect(fold.held.has(data.envelopeCid)).toBe(true);
    expect(fold.set.of("peer.resolved")).toHaveLength(2);
    expect(fold.relationships.relationships.get(R)?.peerChain).toHaveLength(1);

    const { packed, bytes } = await envelopeOf(a, result);
    expect(canonicalize(parseStrict(bytes))).toEqual(bytes);
    const { plaintext, metadata } = await opened(a, packed, bob.secrets, [bob.document]);
    expect(plaintext).toMatchObject({ typ: "application/didcomm-plain+json", id: MESSAGE, type: BASIC_MESSAGE, from: a.longFormDid, to: [BOB], thid: "thread-1", created_time: 1_000, please_ack: [""], lang: "en", body: { content: "hello" } });
    expect(plaintext).not.toHaveProperty("from_prior");
    expect(plaintext).not.toHaveProperty("expires_time");
    expect((plaintext.attachments as JsonObject[]).map((attachment) => attachment.id)).toEqual(["a1", "a2", "a3"]);
    expect(plaintextHash(plaintext)).toBe(data.plaintextHash);
    expect(readPlaintext(plaintext).intentHash).toBe(data.intentHash);
    expect(metadata.encrypted_from_kid).toBe(`${a.longFormDid}#key-2`);
    expect(metadata.encrypted_to_kids).toEqual([`${BOB}#agree`]);

    const seals = await trace.read({ stream: "envelope" });
    expect(seals.map((entry) => [entry.type, entry.data["messageId"], entry.data["packageId"], entry.data["kind"]])).toEqual([["envelope.seal", MESSAGE, result.packageId, "authcrypt"]]);

    const again = await prepare(a.runtime, a.keys, MESSAGE, web);
    expect(again).toMatchObject({ outcome: "none", messageId: MESSAGE, because: expect.stringContaining("awaits submission") });
    expect(web.calls).toEqual([BOB_URL]);
    await expect(prepare(a.runtime, a.keys, THIRD, web)).rejects.toBeInstanceOf(UnknownEntity);
    await a.runtime.close();
  });

  it("no answer from the network leaves the message queued and nothing written; an answer that closes the attempt fails it for good", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    await bound(a, await webResolution(bob));
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const before = [...(await scanVault(a.runtime.vault, a.keys)).set.applied()].length;
    const down = await prepare(a.runtime, a.keys, MESSAGE, options({ fetch: webFetch({ [BOB_URL]: () => new Response("later", { status: 503 }) }).fetch }));
    expect(down).toMatchObject({ outcome: "unavailable", messageId: MESSAGE });
    let fold = await scanVault(a.runtime.vault, a.keys);
    expect([...fold.set.applied()]).toHaveLength(before);
    expect(fold.outbound.outbounds.get(MESSAGE)?.work).toEqual({ kind: "prepare" });

    const trace = await AgentTrace.open(a.runtime.local);
    const gone = await prepare(a.runtime, a.keys, MESSAGE, options({ fetch: webFetch({}).fetch, trace }));
    expect(gone).toMatchObject({ outcome: "failed", messageId: MESSAGE, code: PEER_KEY_CHANGED });
    if (gone.outcome !== "failed") return;
    expect(gone.failed.data).toEqual({ messageId: MESSAGE, scope: "message", packageId: null, code: PEER_KEY_CHANGED });
    fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)?.outcome).toBe("failed");
    expect(fold.outbound.outbounds.get(MESSAGE)?.work).toEqual({ kind: "none", because: `terminal failure: ${PEER_KEY_CHANGED}` });
    expect(fold.set.of("message.prepared")).toEqual([]);
    const diagnostics = await trace.read({ stream: "diag" });
    expect(diagnostics.map((entry) => entry.type)).toEqual(["diag.resolve", "diag.delivery"]);
    expect(diagnostics[1]!.data).toMatchObject({ messageId: MESSAGE, code: PEER_KEY_CHANGED });
    expect(await prepare(a.runtime, a.keys, MESSAGE, serving(bob))).toMatchObject({ outcome: "none" });
    await a.runtime.close();
  });

  it("the peer's key changed under the same DID: a fresh document authorizing none of the pinned keys fails the message and extends no chain; one that still authorizes a pinned key is packed to that key, the fresh evidence recorded beside the pin", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    const pinned = await webResolution(bob);
    const { R, root } = await bound(a, pinned);
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const replaced = await webIdentity(BOB, 78);
    const failed = await prepare(a.runtime, a.keys, MESSAGE, serving(replaced));
    expect(failed).toMatchObject({ outcome: "failed", code: PEER_KEY_CHANGED });
    let fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("peer.resolved")).toHaveLength(1);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    expect(fold.relationships.relationships.get(R)?.peerChain.map((node) => node.documentCid)).toEqual([pinned.cid]);

    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: SECOND });
    const grown: WebIdentity = {
      ...bob,
      document: {
        ...bob.document,
        verificationMethod: [...(bob.document.verificationMethod as JsonObject[]), { ...(replaced.document.verificationMethod as JsonObject[])[1]!, id: `${BOB}#agree2` }],
        keyAgreement: [`${BOB}#agree2`, `${BOB}#agree`],
      },
    };
    const result = await prepare(a.runtime, a.keys, SECOND, serving(grown));
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    const current = await webResolution(grown);
    expect(result.resolved?.data).toMatchObject({ documentCid: current.cid, keyAgreementMethodIds: [`${BOB}#agree2`, `${BOB}#agree`], peerPublicKey: root.data.peerPublicKey });
    expect(result.prepared.data.peerResolutionEventId).toBe(root.eventId);
    fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(SECOND)?.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
    expect(fold.relationships.relationships.get(R)?.peerChain.map((node) => node.documentCid)).toEqual([pinned.cid]);
    const { packed } = await envelopeOf(a, result);
    const { metadata } = await opened(a, packed, bob.secrets, [grown.document]);
    expect(metadata.encrypted_to_kids).toEqual([`${BOB}#agree`]);
    await a.runtime.close();
  });

  it("an expiry that passed fails the message before any network work; one still ahead lets it go", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    await bound(a, await webResolution(bob));
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, { ...HELLO, createdTime: 1_000, expiresTime: 2_000 }, { messageId: MESSAGE });
    const web = serving(bob);
    const expired = await prepare(a.runtime, a.keys, MESSAGE, { ...web, now: () => 2_000 * 1000 });
    expect(expired).toMatchObject({ outcome: "failed", code: EXPIRED });
    expect(web.calls).toEqual([]);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(MESSAGE)?.outcome).toBe("failed");
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, { ...HELLO, createdTime: 1_000, expiresTime: 2_000 }, { messageId: SECOND });
    expect((await prepare(a.runtime, a.keys, SECOND, { ...web, now: () => 1_999 * 1000 })).outcome).toBe("prepared");
    await a.runtime.close();
  });

  it("a verified continuation to another DID committed while the old peer end was being resolved: the answer, confirming or closing, is dropped, the new end resolved afresh and the package addressed to it", async () => {
    for (const reply of ["confirmed", "gone", "same keys"] as const) {
      const a = await alice();
      const bob = await webIdentity(BOB);
      const next = await webIdentity(NEXT, reply === "same keys" ? 77 : 78);
      const pinned = await webResolution(bob);
      const { R, root, binding } = await bound(a, pinned);
      const continued = await webResolution(next, NEXT_URL);
      const evidence = await commitResolution(a.runtime, { resolution: continued, localKeyName: didKeyName(DID, "key-agreement"), peerPublicKey: keyAgreementKey(continued) });
      await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
      const web = webFetch({
        [BOB_URL]: async () => {
          await continuedTo(a, R, root, binding, bob, next, evidence);
          return reply === "gone" ? new Response("moved away", { status: 404 }) : json(bob.document);
        },
        [NEXT_URL]: () => json(next.document),
      });
      const result = await prepare(a.runtime, a.keys, MESSAGE, options({ fetch: web.fetch }));
      expect(result.outcome).toBe("prepared");
      if (result.outcome !== "prepared") return;
      expect(web.calls).toEqual([BOB_URL, NEXT_URL]);
      expect(result.prepared.data.recipientDid).toBe(NEXT);
      expect(result.resolved?.data).toMatchObject({ did: NEXT, documentCid: continued.cid });
      const fold = await scanVault(a.runtime.vault, a.keys);
      expect(fold.set.of("delivery.failed")).toEqual([]);
      expect(fold.set.of("peer.resolved").filter((event) => event.data.did === BOB)).toHaveLength(1);
      expect(fold.relationships.relationships.get(R)?.peerChain.map((node) => node.did)).toEqual([BOB, NEXT]);
      expect(fold.outbound.outbounds.get(MESSAGE)?.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
      const { packed } = await envelopeOf(a, result);
      const { plaintext, metadata } = await opened(a, packed, next.secrets, [next.document]);
      expect(plaintext.to).toEqual([NEXT]);
      expect(metadata.encrypted_to_kids).toEqual([`${NEXT}#agree`]);
      await a.runtime.close();
    }
  });

  it("one message is prepared by one caller at a time: a second call waits for the first and finds its package, asking the network nothing", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    await bound(a, await webResolution(bob));
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => (entered = resolve));
    const paused = new Promise<void>((resolve) => (release = resolve));
    const web = webFetch({
      [BOB_URL]: async () => {
        entered();
        await paused;
        return json(bob.document);
      },
    });
    const first = prepare(a.runtime, a.keys, MESSAGE, options({ fetch: web.fetch }));
    await started;
    const second = prepare(a.runtime, a.keys, MESSAGE, options({ fetch: web.fetch }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(web.calls).toEqual([BOB_URL]);
    release();
    expect((await first).outcome).toBe("prepared");
    expect(await second).toMatchObject({ outcome: "none", because: expect.stringContaining("awaits submission") });
    expect(web.calls).toEqual([BOB_URL]);
    await a.runtime.close();
  });

  it("a document that also authorizes a key on another curve: the key the sender can seal to is chosen whatever the order, on a birth and on a bound pair; a document with no such key fails the message and binds nothing", async () => {
    const { publicKey } = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const jwk = await crypto.subtle.exportKey("jwk", publicKey);
    const p256: JsonObject = { id: `${BOB}#p256`, type: "JsonWebKey2020", controller: BOB, publicKeyJwk: { kty: jwk.kty as string, crv: jwk.crv as string, x: jwk.x as string, y: jwk.y as string } };
    const withP256 = (bob: WebIdentity, keyAgreement: string[]): WebIdentity => ({ ...bob, document: { ...bob.document, verificationMethod: [p256, ...(bob.document.verificationMethod as JsonObject[])], keyAgreement } });
    for (const birth of [true, false]) {
      const a = await alice();
      const bob = withP256(await webIdentity(BOB), [`${BOB}#p256`, `${BOB}#agree`]);
      const resolution = await webResolution(bob);
      expect(authorizedKeys(resolution, "keyAgreement").size).toBe(2);
      if (!birth) await bound(a, resolution);
      await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
      const result = await prepare(a.runtime, a.keys, MESSAGE, serving(bob));
      expect(result.outcome).toBe("prepared");
      if (result.outcome !== "prepared") return;
      expect(result.bound === null).toBe(!birth);
      const x25519 = authorizedKeys(resolution, "keyAgreement").get(`${BOB}#agree` as DidUrl);
      const fold = await scanVault(a.runtime.vault, a.keys);
      expect(fold.set.resolve(result.prepared.data.peerResolutionEventId, "peer.resolved")).toMatchObject({ status: "present", event: { data: { peerPublicKey: x25519 } } });
      expect(fold.outbound.outbounds.get(MESSAGE)?.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
      const { packed } = await envelopeOf(a, result);
      const { metadata } = await opened(a, packed, bob.secrets, [bob.document]);
      expect(metadata.encrypted_to_kids).toEqual([`${BOB}#agree`]);
      await a.runtime.close();
    }
    const a = await alice();
    const bob = withP256(await webIdentity(BOB), [`${BOB}#p256`]);
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    expect(await prepare(a.runtime, a.keys, MESSAGE, serving(bob))).toMatchObject({ outcome: "failed", code: PEER_KEY_CHANGED });
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("relationship.bound")).toEqual([]);
    expect(fold.set.of("peer.resolved")).toEqual([]);
    expect(fold.outbound.outbounds.get(MESSAGE)?.outcome).toBe("failed");
    await a.runtime.close();
  });
  it("a document that also authorizes a key-agreement method of a suite didcomm does not pack with: the method it packs with is chosen whatever the order, even when both carry one key; a document with only the other suite fails the message and binds nothing", async () => {
    const other = await webIdentity(BOB, 91);
    const foreign = (bob: WebIdentity, shared: boolean): JsonObject => ({
      ...(shared ? (bob.document.verificationMethod as JsonObject[])[1]! : (other.document.verificationMethod as JsonObject[])[1]!),
      id: `${BOB}#extension`,
      type: "ExampleX25519Key",
    });
    const withForeign = (bob: WebIdentity, shared: boolean, keyAgreement: string[]): WebIdentity => ({ ...bob, document: { ...bob.document, verificationMethod: [foreign(bob, shared), ...(bob.document.verificationMethod as JsonObject[])], keyAgreement } });
    for (const [birth, shared] of [
      [true, false],
      [false, false],
      [false, true],
    ] as const) {
      const a = await alice();
      const bob = withForeign(await webIdentity(BOB), shared, [`${BOB}#extension`, `${BOB}#agree`]);
      const resolution = await webResolution(bob);
      expect(authorizedKeys(resolution, "keyAgreement").size).toBe(2);
      if (!birth) await bound(a, resolution);
      await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
      const result = await prepare(a.runtime, a.keys, MESSAGE, serving(bob));
      expect(result.outcome).toBe("prepared");
      if (result.outcome !== "prepared") return;
      expect(result.bound === null).toBe(!birth);
      const fold = await scanVault(a.runtime.vault, a.keys);
      expect(fold.outbound.outbounds.get(MESSAGE)?.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
      const { packed } = await envelopeOf(a, result);
      const { metadata } = await opened(a, packed, bob.secrets, [bob.document]);
      expect(metadata.encrypted_to_kids).toEqual([`${BOB}#agree`]);
      await a.runtime.close();
    }
    const a = await alice();
    const bob = withForeign(await webIdentity(BOB), false, [`${BOB}#extension`]);
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    expect(await prepare(a.runtime, a.keys, MESSAGE, serving(bob))).toMatchObject({ outcome: "failed", code: PEER_KEY_CHANGED });
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("relationship.bound")).toEqual([]);
    expect(fold.set.of("peer.resolved")).toEqual([]);
    await a.runtime.close();
  });
});

describe("prepare to a numalgo-4 peer", () => {
  const fetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = () => Promise.reject(new Error("the network is off"));
  });
  afterEach(() => {
    globalThis.fetch = fetch;
  });

  it("a pair born offline is bound under the lock from the long form the intent froze, then packed, with the network off; a later message in the relationship names the same pin", async () => {
    const a = await alice();
    const b = await bobVault();
    const ring = await Keyring.load(b.keys, await scanVault(b.runtime.vault, b.keys));
    const sent = await send(a.runtime, a.keys, { peerDid: b.longFormDid, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const result = await prepare(a.runtime, a.keys, MESSAGE, options());
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.resolved).toBeNull();
    expect(result.bound?.data).toMatchObject({ relationshipId: sent.relationshipId, localDidId: DID });
    expect(result.prepared.data).toMatchObject({ senderDidId: DID, recipientDid: b.did, peerResolutionEventId: result.bound!.data.peerResolutionEventId, fromPrior: null });
    let fold = await scanVault(a.runtime.vault, a.keys);
    const relationship = fold.relationships.relationships.get(sent.relationshipId)!;
    expect(relationship.localChain.map((node) => node.didId)).toEqual([DID]);
    expect(relationship.peerChain.map((node) => node.did)).toEqual([b.did]);
    expect(unfinishedWork(fold).births).toEqual([]);
    expect(fold.outbound.outbounds.get(MESSAGE)?.work).toEqual({ kind: "submit", packageIds: [result.packageId] });
    expect(fold.set.of("peer.resolved").map((event) => event.data.presentedDid)).toEqual([b.longFormDid]);

    const { packed } = await envelopeOf(a, result);
    const { plaintext, metadata } = await opened(a, packed, ring.secrets(), []);
    expect(plaintext).toMatchObject({ id: MESSAGE, from: a.longFormDid, to: [b.did], body: { content: "hello" } });
    expect(metadata.encrypted_to_kids).toEqual([`${b.did}#key-2`]);

    const second = await send(a.runtime, a.keys, { peerDid: b.did, sender: { didId: DID } }, HELLO, { messageId: SECOND });
    expect(second.birth).toBeNull();
    const next = await prepare(a.runtime, a.keys, SECOND, options());
    expect(next).toMatchObject({ outcome: "prepared", bound: null, resolved: null });
    if (next.outcome !== "prepared") return;
    expect(next.prepared.data.peerResolutionEventId).toBe(result.prepared.data.peerResolutionEventId);
    fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("peer.resolved")).toHaveLength(1);
    expect(fold.set.of("relationship.bound")).toHaveLength(1);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a birth at a short form whose long form is in no evidence fails the message: nothing resolves it", async () => {
    const a = await alice();
    const b = await bobVault();
    await send(a.runtime, a.keys, { peerDid: b.did, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const result = await prepare(a.runtime, a.keys, MESSAGE, options());
    expect(result).toMatchObject({ outcome: "failed", code: PEER_KEY_CHANGED });
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("relationship.bound")).toEqual([]);
    expect(fold.outbound.outbounds.get(MESSAGE)?.outcome).toBe("failed");
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a binding a reverse-direction receipt made meanwhile is reused: the queued birth is packed in it, no second binding or pin", async () => {
    const a = await alice();
    const b = await bobVault();
    const sent = await send(a.runtime, a.keys, { peerDid: b.longFormDid, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const { R, root, binding } = await bound(a, await peerResolutionOf(b.longFormDid));
    expect(R).toBe(sent.relationshipId);
    const result = await prepare(a.runtime, a.keys, MESSAGE, options());
    expect(result).toMatchObject({ outcome: "prepared", bound: null, resolved: null });
    if (result.outcome !== "prepared") return;
    expect(result.prepared.data.peerResolutionEventId).toBe(root.eventId);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("relationship.bound").map((event) => event.eventId)).toEqual([binding.eventId]);
    expect(fold.set.of("peer.resolved")).toHaveLength(1);
    expect(fold.outbound.outbounds.get(MESSAGE)?.packages.get(result.packageId)?.membership).toEqual({ status: "verified" });
    await a.runtime.close();
    await b.runtime.close();
  });

  it("a local rotation retires the packages from the predecessor and repacks from the successor, under its long form and with the transition's proof, until input at the successor confirms it", async () => {
    const a = await alice();
    const b = await bobVault();
    const ring = await Keyring.load(b.keys, await scanVault(b.runtime.vault, b.keys));
    const resolution = await peerResolutionOf(b.longFormDid);
    const { R, binding } = await bound(a, resolution);
    await send(a.runtime, a.keys, { peerDid: b.did, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    const fromRoot = await prepare(a.runtime, a.keys, MESSAGE, options());
    if (fromRoot.outcome !== "prepared") throw new Error(fromRoot.outcome);
    expect((await opened(a, (await envelopeOf(a, fromRoot)).packed, ring.secrets(), [])).plaintext.from).toBe(a.longFormDid);

    await confirmedAt(a, R, DID, resolution, binding, "wire-1");
    await send(a.runtime, a.keys, { peerDid: b.did, sender: { didId: DID } }, HELLO, { messageId: SECOND });
    const confirmed = await prepare(a.runtime, a.keys, SECOND, options());
    if (confirmed.outcome !== "prepared") throw new Error(confirmed.outcome);
    const { plaintext: short, metadata: shortMetadata } = await opened(a, (await envelopeOf(a, confirmed)).packed, ring.secrets(), []);
    expect(short.from).toBe(a.did);
    expect(shortMetadata.encrypted_from_kid).toBe(`${a.did}#key-2`);

    const { minted: successor } = await createDid(a.runtime, a.keys, ROUTE, FRESH);
    const proof = await signFromPrior(a.keys, { didId: DID, longFormDid: a.longFormDid }, successor.longFormDid, IAT);
    await a.runtime.vault.commit([], [vaultDraft("relationship.localTransitioned", { relationshipId: R, fromDidId: DID, toDidId: FRESH, fromPrior: proof, triggerEventId: null })]);
    let fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.relationships.relationships.get(R)?.currentLocalDidId).toBe(FRESH);
    expect(fold.outbound.outbounds.get(MESSAGE)?.work).toEqual({ kind: "repack", packageIds: [fromRoot.packageId] });

    const repacked = await prepare(a.runtime, a.keys, MESSAGE, options());
    expect(repacked.outcome).toBe("prepared");
    if (repacked.outcome !== "prepared") return;
    expect(repacked.retired.map((event) => event.data)).toEqual([{ messageId: MESSAGE, packageId: fromRoot.packageId, because: "repacked", replacementPackageId: repacked.packageId }]);
    expect(repacked.prepared.data).toMatchObject({ senderDidId: FRESH, localKeyName: didKeyName(FRESH, "key-agreement"), fromPrior: proof, intentHash: fromRoot.prepared.data.intentHash });
    expect(repacked.prepared.data.plaintextHash).not.toBe(fromRoot.prepared.data.plaintextHash);
    expect(repacked.prepared.data.peerResolutionEventId).not.toBe(fromRoot.prepared.data.peerResolutionEventId);
    fold = await scanVault(a.runtime.vault, a.keys);
    const outbound = fold.outbound.outbounds.get(MESSAGE)!;
    expect(outbound.work).toEqual({ kind: "submit", packageIds: [repacked.packageId] });
    expect(outbound.packages.get(fromRoot.packageId)).toMatchObject({ retired: "repacked", active: false, membership: { status: "verified" } });
    expect(fold.held.has(fromRoot.prepared.data.envelopeCid)).toBe(false);
    expect(fold.held.has(repacked.prepared.data.envelopeCid)).toBe(true);
    expect(fold.set.of("peer.resolved").map((event) => event.data.localKeyName)).toEqual([didKeyName(DID, "key-agreement"), didKeyName(FRESH, "key-agreement")]);
    const { plaintext: rotated, metadata } = await opened(a, (await envelopeOf(a, repacked)).packed, ring.secrets(), []);
    expect(rotated).toMatchObject({ id: MESSAGE, from: successor.longFormDid, from_prior: proof, to: [b.did] });
    expect(metadata.from_prior_issuer_kid).toBe(`${a.longFormDid}#key-1`);
    expect(metadata.encrypted_from_kid).toBe(`${successor.longFormDid}#key-2`);

    const stillProven = await prepare(a.runtime, a.keys, SECOND, options());
    if (stillProven.outcome !== "prepared") throw new Error(stillProven.outcome);
    expect(stillProven.prepared.data.fromPrior).toBe(proof);
    await confirmedAt(a, R, FRESH, resolution, binding, "wire-2");
    await send(a.runtime, a.keys, { peerDid: b.did, sender: { didId: DID } }, HELLO, { messageId: THIRD });
    const settled = await prepare(a.runtime, a.keys, THIRD, options());
    if (settled.outcome !== "prepared") throw new Error(settled.outcome);
    expect(settled.prepared.data).toMatchObject({ senderDidId: FRESH, fromPrior: null });
    expect((await opened(a, (await envelopeOf(a, settled)).packed, ring.secrets(), [])).plaintext.from).toBe(successor.did);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("prepareAll walks every outbound owed a package in message order, each on its own", async () => {
    const a = await alice();
    const b = await bobVault();
    const bob = await webIdentity(BOB);
    await bound(a, await webResolution(bob));
    await send(a.runtime, a.keys, { peerDid: b.longFormDid, sender: { didId: DID } }, HELLO, { messageId: THIRD });
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: MESSAGE });
    await send(a.runtime, a.keys, { peerDid: BOB, sender: { didId: DID } }, HELLO, { messageId: SECOND });
    const down = await prepareAll(a.runtime, a.keys, options({ fetch: webFetch({ [BOB_URL]: () => new Response("later", { status: 503 }) }).fetch }));
    expect(down.map((result) => [result.messageId, result.outcome])).toEqual([
      [MESSAGE, "unavailable"],
      [SECOND, "unavailable"],
      [THIRD, "prepared"],
    ]);
    const up = await prepareAll(a.runtime, a.keys, serving(bob));
    expect(up.map((result) => [result.messageId, result.outcome])).toEqual([
      [MESSAGE, "prepared"],
      [SECOND, "prepared"],
    ]);
    expect(await prepareAll(a.runtime, a.keys, serving(bob))).toEqual([]);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect([...fold.outbound.outbounds.values()].map((outbound) => outbound.outcome)).toEqual(["prepared", "prepared", "prepared"]);
    expect(fold.set.of("peer.resolved")).toHaveLength(4);
    await a.runtime.close();
    await b.runtime.close();
  });

  it("the trace is written after the lock and never stops the mail: a trace that rejects loses its entry alone, and a trace that stalls holds no other writer", async () => {
    const a = await alice();
    const b = await bobVault();
    const to = { peerDid: b.longFormDid, sender: { didId: DID } };
    await send(a.runtime, a.keys, to, HELLO, { messageId: MESSAGE });
    await send(a.runtime, a.keys, to, { ...HELLO, createdTime: 1_000, expiresTime: 2_000 }, { messageId: SECOND });
    const rejecting = new AgentTrace({ ...a.runtime.local, trace: { ...a.runtime.local.trace, append: () => Promise.reject(new Error("trace full")) } });
    expect((await prepare(a.runtime, a.keys, MESSAGE, options({ trace: rejecting }))).outcome).toBe("prepared");
    expect(await prepare(a.runtime, a.keys, SECOND, options({ trace: rejecting, now: () => 2_000 * 1000 }))).toMatchObject({ outcome: "failed", code: EXPIRED });
    let fold = await scanVault(a.runtime.vault, a.keys);
    expect([MESSAGE, SECOND].map((messageId) => fold.outbound.outbounds.get(messageId)?.outcome)).toEqual(["prepared", "failed"]);

    await send(a.runtime, a.keys, to, HELLO, { messageId: THIRD });
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const stalled = new Promise<void>((resolve) => (release = resolve));
    const stalling = new AgentTrace({
      ...a.runtime.local,
      trace: {
        ...a.runtime.local.trace,
        append: async (type, data) => {
          entered();
          await stalled;
          return a.runtime.local.trace.append(type, data);
        },
      },
    });
    const preparing = prepare(a.runtime, a.keys, THIRD, options({ trace: stalling }));
    await inside;
    const meanwhile = await send(a.runtime, a.keys, to, HELLO, { messageId: FOURTH });
    expect(meanwhile.intent.data.messageId).toBe(FOURTH);
    fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.outbound.outbounds.get(THIRD)?.outcome).toBe("prepared");
    release();
    const result = await preparing;
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    const seals = await stalling.read({ stream: "envelope" });
    expect(seals.map((entry) => [entry.type, entry.data["messageId"]])).toEqual([["envelope.seal", THIRD]]);
    await a.runtime.close();
    await b.runtime.close();
  });
});
