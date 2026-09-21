import { describe, expect, it } from "vitest";

import { FromPrior } from "@estoc/didcomm-node";
import { longToShort, resolveDIDCommDoc, toDIDCommDIDDoc } from "@estoc/did-peer";
import { MemoryVault } from "@estoc/event-store";
import { didKeyName, objectReader, peerResolution, scanVault, type Did, type DidId, type PublicKey, type RouteId } from "@estoc/vault";

import { Keyring, UnauthorizedKey, authorizedKeys, commitResolution, configureRoute, createDid, didcommDocumentOf, knownLongForms, pinnedResolver, readResolution, resolve, secretsResolverFor, type Resolution } from "../src/index.js";
import { didcomm, freshVault, json, newMediator, webFetch, webIdentity, type Fresh, type WebIdentity } from "./helpers.js";

const BOB = "did:web:bob.example";
const BOB_URL = "https://bob.example/.well-known/did.json";
const ROUTE = "019b0000-0000-7000-8000-00000000000a" as RouteId;
const DID = "019b0000-0000-7000-8000-00000000000b" as DidId;
const LOCAL_KEY = didKeyName(DID, "key-agreement");

async function webResolution(identity: WebIdentity): Promise<Resolution> {
  const outcome = await resolve(identity.did, () => null, { fetch: webFetch({ [BOB_URL]: () => json(identity.document) }).fetch });
  if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
  return outcome.resolution;
}

function keyAgreementKey(resolution: Resolution): PublicKey {
  const [key] = authorizedKeys(resolution, "keyAgreement").values();
  return key as PublicKey;
}

/** Alice: a vault with one communication DID on a direct route, and her keys in hand. */
async function alice(): Promise<Fresh & { did: Did; longFormDid: Did; ring: Keyring }> {
  const fresh = await freshVault();
  await configureRoute(fresh.runtime, fresh.keys, { kind: "direct", endpoint: "https://alice.example/didcomm" }, ROUTE);
  const { minted } = await createDid(fresh.runtime, fresh.keys, ROUTE, DID);
  const ring = await Keyring.load(fresh.keys, await scanVault(fresh.runtime.vault, fresh.keys));
  return { ...fresh, did: minted.did, longFormDid: minted.longFormDid, ring };
}

describe("peer.resolved", () => {
  it("is committed with its document object, verified by the fold, and reused for an equal resolution unless fresh evidence is asked for", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB);
    const resolution = await webResolution(bob);
    const evidence = { resolution, localKeyName: LOCAL_KEY, peerPublicKey: keyAgreementKey(resolution) };
    const event = await commitResolution(a.runtime, evidence);
    expect(event.type).toBe("peer.resolved");
    expect(event.roots).toEqual([resolution.cid]);
    expect(event.data).toEqual({
      localKeyName: LOCAL_KEY,
      peerPublicKey: evidence.peerPublicKey,
      presentedDid: BOB,
      did: BOB,
      documentCid: resolution.cid,
      authenticationMethodIds: [`${BOB}#auth`],
      keyAgreementMethodIds: [`${BOB}#agree`],
      service: "https://bob.example/didcomm",
    });
    expect(await a.runtime.vault.objects.has(resolution.cid)).toBe(true);
    let fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.checks.resolutionChecks.get(event.eventId)).toBe("verified");
    expect(fold.held.has(resolution.cid)).toBe(true);

    expect((await commitResolution(a.runtime, evidence)).eventId).toBe(event.eventId);
    const fresh = await commitResolution(a.runtime, evidence, { fresh: true });
    expect(fresh.eventId).not.toBe(event.eventId);
    const otherKey = await commitResolution(a.runtime, { ...evidence, localKeyName: didKeyName("019b0000-0000-7000-8000-00000000000c" as DidId, "key-agreement") });
    expect(otherKey.eventId).not.toBe(event.eventId);
    fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("peer.resolved")).toHaveLength(3);
    expect([...fold.checks.resolutionChecks.values()]).toEqual(["verified", "verified", "verified"]);

    expect(await readResolution(event, objectReader(a.runtime.vault.objects))).toEqual(resolution);
    expect(await readResolution(event, async () => null)).toBeNull();
    await a.runtime.close();
  });

  it("evidence that arrived without its document is repaired by the same document in hand, and the original pin reads again", async () => {
    const a = await alice();
    const resolution = await webResolution(await webIdentity(BOB));
    const evidence = { resolution, localKeyName: LOCAL_KEY, peerPublicKey: keyAgreementKey(resolution) };
    const event = await commitResolution(a.runtime, evidence);
    const copy = new MemoryVault({ metadata: a.runtime.metadata });
    await copy.ingest([event]);
    const read = objectReader(copy.vault.objects);
    expect(await copy.vault.objects.has(resolution.cid)).toBe(false);
    expect(await readResolution(event, read)).toBeNull();
    const repaired = await commitResolution(copy, evidence);
    expect(repaired.eventId).not.toBe(event.eventId);
    expect(await copy.vault.objects.has(resolution.cid)).toBe(true);
    expect(await readResolution(event, read)).toEqual(resolution);
    expect([event.eventId, repaired.eventId]).toContain((await commitResolution(copy, evidence)).eventId);
    const fold = await scanVault(copy.vault, a.keys);
    expect(fold.set.of("peer.resolved").map((e) => e.eventId)).toEqual([event.eventId, repaired.eventId]);
    expect([...fold.checks.resolutionChecks.values()]).toEqual(["verified", "verified"]);
    await a.runtime.close();
  });

  it("refuses a key the document does not authorize, writing nothing", async () => {
    const a = await alice();
    const resolution = await webResolution(await webIdentity(BOB));
    const stranger = keyAgreementKey(await webResolution(await webIdentity(BOB, 78)));
    await expect(commitResolution(a.runtime, { resolution, localKeyName: LOCAL_KEY, peerPublicKey: stranger })).rejects.toBeInstanceOf(UnauthorizedKey);
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.set.of("peer.resolved")).toEqual([]);
    expect(await a.runtime.vault.objects.has(resolution.cid)).toBe(false);
    await a.runtime.close();
  });

  it("a numalgo-4 peer resolved under its long form and later its short form retains one document and one CID", async () => {
    const a = await alice();
    const peer = await newMediator(201);
    const long = await resolve(peer.did, () => null);
    if (long.outcome !== "resolved") throw new Error(long.reason);
    const first = await commitResolution(a.runtime, { resolution: long.resolution, localKeyName: LOCAL_KEY, peerPublicKey: keyAgreementKey(long.resolution) });
    const shortForm = longToShort(peer.did);
    const short = await resolve(shortForm, knownLongForms(await scanVault(a.runtime.vault, a.keys)));
    if (short.outcome !== "resolved") throw new Error(short.reason);
    const second = await commitResolution(a.runtime, { resolution: short.resolution, localKeyName: LOCAL_KEY, peerPublicKey: keyAgreementKey(short.resolution) });
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.data).toMatchObject({ presentedDid: shortForm, did: shortForm, documentCid: first.data.documentCid });
    const fold = await scanVault(a.runtime.vault, a.keys);
    expect(fold.checks.resolutionChecks.get(second.eventId)).toBe("verified");
    const read = objectReader(a.runtime.vault.objects);
    const [fromLong, fromShort] = [await readResolution(first, read), await readResolution(second, read)];
    expect(fromShort?.document).toEqual(fromLong?.document);
    expect(fromShort?.document["id"]).toBe(peer.did);
    expect(fromShort?.bytes).toEqual(peerResolution(peer.did).bytes);
    await a.runtime.close();
  });
});

describe("the resolver didcomm reads", () => {
  it("answers the document under the spelling asked for: a resolution under either numalgo-4 form, this vault's own entities, a long form from itself", async () => {
    const a = await alice();
    const peer = await newMediator(201);
    const outcome = await resolve(peer.did, () => null);
    if (outcome.outcome !== "resolved") throw new Error(outcome.reason);
    const fold = await scanVault(a.runtime.vault, a.keys);
    const resolver = pinnedResolver(fold, { current: [outcome.resolution] });
    const shortForm = longToShort(peer.did);
    expect(await resolver.resolve(peer.did)).toEqual(await resolveDIDCommDoc(peer.did));
    expect((await resolver.resolve(shortForm))?.keyAgreement).toEqual([`${shortForm}#key-2`]);
    expect(didcommDocumentOf(outcome.resolution, shortForm).id).toBe(shortForm);
    expect(() => didcommDocumentOf(outcome.resolution, a.did)).toThrow(/not a spelling/);
    expect((await resolver.resolve(a.longFormDid))?.id).toBe(a.longFormDid);
    expect((await resolver.resolve(a.did))?.keyAgreement).toEqual([`${a.did}#key-2`]);
    const other = await newMediator(202);
    expect((await resolver.resolve(other.did))?.id).toBe(other.did);
    expect(await resolver.resolve(longToShort(other.did))).toBeNull();
    expect(await resolver.resolve("did:web:nobody.example")).toBeNull();
    expect(await resolver.resolve("nonsense")).toBeNull();
    await a.runtime.close();
  });

  it("a sender is read from the current resolution and a from_prior issuer from the pinned one, never from a later revision", async () => {
    const a = await alice();
    const bob = await webIdentity(BOB, 77);
    const bobRotated = await webIdentity(BOB, 78);
    const current = await webResolution(bob);
    const rotated = await webResolution(bobRotated);
    expect(rotated.cid).not.toBe(current.cid);
    const fold = await scanVault(a.runtime.vault, a.keys);
    const bobSide = { resolve: async (did: string) => (did === BOB ? toDIDCommDIDDoc(bob.document) : resolveDIDCommDoc(did)) };
    const plaintext = { id: "m1", typ: "application/didcomm-plain+json", type: "https://didcomm.org/basicmessage/2.0/message", from: BOB, to: [a.longFormDid], body: { content: "hi" } };
    const [packed] = await new didcomm.Message(plaintext).pack_encrypted(a.longFormDid, BOB, null, bobSide, secretsResolverFor(bob.secrets), { forward: false });
    const secrets = secretsResolverFor(a.ring.secrets());
    const [opened, metadata] = await didcomm.Message.unpack(packed, pinnedResolver(fold, { current: [current] }), secrets, {});
    expect(opened.as_value().body).toEqual({ content: "hi" });
    expect(metadata.encrypted_from_kid).toBe(`${BOB}#agree`);
    await expect(didcomm.Message.unpack(packed, pinnedResolver(fold, { current: [rotated] }), secrets, {})).rejects.toThrow();
    await expect(didcomm.Message.unpack(packed, pinnedResolver(fold, {}), secrets, {})).rejects.toThrow();

    const successor = await newMediator(203);
    const successorSide = { resolve: async (did: string) => (did === BOB ? toDIDCommDIDDoc(bob.document) : resolveDIDCommDoc(did)) };
    const [fromPrior] = await new FromPrior({ iss: BOB, sub: successor.did }).pack(`${BOB}#auth`, successorSide, secretsResolverFor(bob.secrets));
    const continuing = { ...plaintext, id: "m2", from: successor.did, from_prior: fromPrior };
    const [carried] = await new didcomm.Message(continuing).pack_encrypted(a.longFormDid, successor.did, null, successorSide, secretsResolverFor(successor.secrets), { forward: false });
    const [, carriedMetadata] = await didcomm.Message.unpack(carried, pinnedResolver(fold, { pinned: [current] }), secrets, {});
    expect(carriedMetadata.from_prior_issuer_kid).toBe(`${BOB}#auth`);
    expect(carriedMetadata.encrypted_from_kid).toBe(`${successor.did}#key-2`);
    await expect(didcomm.Message.unpack(carried, pinnedResolver(fold, { pinned: [rotated] }), secrets, {})).rejects.toThrow();
    await a.runtime.close();
  });
});
