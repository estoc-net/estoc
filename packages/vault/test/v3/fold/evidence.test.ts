import { canonicalize, type JsonObject } from "@estoc/event-store/v3";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import { InvalidDidDocument, VaultEventSet, authorizedMethodIds, canonicalPublicKey, didKeyName, foldVaultChecked, methodPublicKey, rawCidOfBytes, resolvedDocumentOf, verifyResolutions, type Cid, type Did, type EventId, type EvidenceCheck, type Keys } from "../../../src/v3/index.js";
import { PEER_ID0, PEER_ID3, noObjects, peerAgreeingOn, resolved, vaults, type Peer } from "./scene.js";

const WEB_DID = "did:web:bob.example" as Did;

const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;

async function webPeer(peerKeys: Keys, edit: (document: JsonObject) => JsonObject = (document) => document): Promise<Peer & { bytes: Uint8Array }> {
  const signer = await peerKeys.signing(didKeyName(PEER_ID0, "authentication"));
  const agreer = await peerKeys.agreement(didKeyName(PEER_ID0, "key-agreement"));
  const document = edit({
    id: WEB_DID,
    verificationMethod: [
      { id: `${WEB_DID}#key-1`, type: "Multikey", controller: WEB_DID, publicKeyMultibase: signer.publicKey },
      { id: `${WEB_DID}#key-2`, type: "Multikey", controller: WEB_DID, publicKeyMultibase: agreer.publicKey },
    ],
    authentication: [`${WEB_DID}#key-1`],
    keyAgreement: [`${WEB_DID}#key-2`],
  });
  const bytes = canonicalize(document);
  const [keyAgreement] = authorizedMethodIds(document, "keyAgreement");
  const publicKey = keyAgreement === undefined ? agreer.publicKey : methodPublicKey(document, keyAgreement);
  return { didId: PEER_ID0, did: WEB_DID, longFormDid: WEB_DID, resolution: { did: WEB_DID, presentedDid: WEB_DID, document, bytes, cid: rawCidOfBytes(bytes) }, publicKey, bytes };
}

describe("verifyResolutions", () => {
  it("verifies a long-form snapshot from the spelling alone, a short-form and a did:web snapshot only from the retained document", async () => {
    const { scene, peerKeys, a0, b0 } = await vaults();
    const long = resolved(scene, a0.didId, b0);
    const short = resolved(scene, a0.didId, b0, { short: true });
    const web = await webPeer(peerKeys);
    const fetched = resolved(scene, a0.didId, web);
    const set = VaultEventSet.of(scene.events);
    expect(await verifyResolutions(set, noObjects)).toEqual(new Map<EventId, EvidenceCheck>([[long.eventId, "verified"]]));
    expect(await resolvedDocumentOf(short.data, noObjects)).toBeNull();
    expect(await resolvedDocumentOf(fetched.data, noObjects)).toBeNull();
    const readObject = readerOf(new Map([[web.resolution.cid, web.bytes], [b0.resolution.cid, b0.resolution.bytes]]));
    expect(await verifyResolutions(set, readObject)).toEqual(new Map<EventId, EvidenceCheck>([[long.eventId, "verified"], [short.eventId, "verified"], [fetched.eventId, "verified"]]));
    expect(await resolvedDocumentOf(fetched.data, readObject)).toEqual(web.resolution.document);
    expect(await resolvedDocumentOf(long.data, noObjects)).toEqual(b0.resolution.document);
  });

  it("finds a snapshot invalid that names another document's CID, methods that are not the document's, or a key the document does not authorize", async () => {
    const { scene, a0, b0, b2 } = await vaults();
    const forged = resolved(scene, a0.didId, b0, { documentCid: b2.resolution.cid, keyAgreementMethodIds: authorizedMethodIds(b2.resolution.document, "keyAgreement") });
    const noMethods = resolved(scene, a0.didId, b0, { authenticationMethodIds: [] });
    const wrongKey = resolved(scene, a0.didId, b0, { peerPublicKey: b2.publicKey });
    const genuine = resolved(scene, a0.didId, b0);
    const checks = await verifyResolutions(VaultEventSet.of(scene.events), noObjects);
    expect(checks.get(forged.eventId)).toBe("invalid");
    expect(checks.get(noMethods.eventId)).toBe("invalid");
    expect(checks.get(wrongKey.eventId)).toBe("invalid");
    expect(checks.get(genuine.eventId)).toBe("verified");
    await expect(resolvedDocumentOf(forged.data, noObjects)).rejects.toBeInstanceOf(InvalidDidDocument);
  });

  it("takes only a key the document authorizes for key agreement, of a type that agrees keys: an authentication-only key, or an Ed25519 key listed under keyAgreement, is no peer key", async () => {
    const { scene, peerKeys, a0, b0 } = await vaults();
    const [authentication] = authorizedMethodIds(b0.resolution.document, "authentication");
    const signingOnly = resolved(scene, a0.didId, b0, { peerPublicKey: methodPublicKey(b0.resolution.document, authentication!) });
    const signingListed = await webPeer(peerKeys, (document) => ({ ...document, keyAgreement: [`${WEB_DID}#key-1`, `${WEB_DID}#key-2`] }));
    const signingKey = await peerKeys.signing(didKeyName(PEER_ID0, "authentication"));
    const agreeingKey = await peerKeys.agreement(didKeyName(PEER_ID0, "key-agreement"));
    const listedButSigning = resolved(scene, a0.didId, signingListed, { peerPublicKey: signingKey.publicKey });
    const listedAndAgreeing = resolved(scene, a0.didId, signingListed, { peerPublicKey: agreeingKey.publicKey });
    const genuine = resolved(scene, a0.didId, b0);
    const checks = await verifyResolutions(VaultEventSet.of(scene.events), readerOf(new Map([[signingListed.resolution.cid, signingListed.bytes]])));
    expect(checks.get(signingOnly.eventId)).toBe("invalid");
    expect(checks.get(listedButSigning.eventId)).toBe("invalid");
    expect(checks.get(listedAndAgreeing.eventId)).toBe("verified");
    expect(checks.get(genuine.eventId)).toBe("verified");
  });

  it("takes no low-order X25519 point as the peer key, however the document lists it: with such a point every shared secret is zero", async () => {
    const { scene, peerKeys, a0, b0 } = await vaults();
    const lowOrder = (u: number) => canonicalPublicKey({ kty: "OKP", crv: "X25519", x: base64urlnopad.encode(Uint8Array.from([u, ...new Array<number>(31).fill(0)])) });
    const derived = await Promise.all([0, 1].map(async (u) => resolved(scene, a0.didId, await peerAgreeingOn(peerKeys, PEER_ID3, lowOrder(u)))));
    const web = await webPeer(peerKeys, (document) => ({ ...document, verificationMethod: [(document["verificationMethod"] as JsonObject[])[0]!, { id: `${WEB_DID}#key-2`, type: "Multikey", controller: WEB_DID, publicKeyMultibase: lowOrder(0) }] }));
    const fetched = resolved(scene, a0.didId, web);
    const genuine = resolved(scene, a0.didId, b0);
    const checks = await verifyResolutions(VaultEventSet.of(scene.events), readerOf(new Map([[web.resolution.cid, web.bytes]])));
    for (const event of derived) expect(checks.get(event.eventId)).toBe("invalid");
    expect(web.publicKey).toBe(lowOrder(0));
    expect(checks.get(fetched.eventId)).toBe("invalid");
    expect(checks.get(genuine.eventId)).toBe("verified");
  });

  it("a numalgo-4 document read back must be what its long form derives: another key's document under this DID's id is no snapshot of it", async () => {
    const { scene, a0, b0, b2 } = await vaults();
    const forgedDocument = { ...b2.resolution.document, id: b0.longFormDid, alsoKnownAs: [b0.did] };
    const forgedBytes = canonicalize(forgedDocument);
    const forged = resolved(scene, a0.didId, b0, {
      short: true,
      documentCid: rawCidOfBytes(forgedBytes),
      peerPublicKey: b2.publicKey,
      authenticationMethodIds: authorizedMethodIds(forgedDocument, "authentication"),
      keyAgreementMethodIds: authorizedMethodIds(forgedDocument, "keyAgreement"),
    });
    const genuine = resolved(scene, a0.didId, b0, { short: true });
    const readObject = readerOf(new Map([[forged.data.documentCid, forgedBytes], [b0.resolution.cid, b0.resolution.bytes]]));
    const checks = await verifyResolutions(VaultEventSet.of(scene.events), readObject);
    expect(checks.get(forged.eventId)).toBe("invalid");
    expect(checks.get(genuine.eventId)).toBe("verified");
    expect(await resolvedDocumentOf(genuine.data, readObject)).toEqual(b0.resolution.document);
    expect(await resolvedDocumentOf(genuine.data, noObjects)).toBeNull();
  });

  it("finds a snapshot invalid whose presented long form hashes right but encodes no JSON, and still folds the others", async () => {
    const { scene, a0, b0 } = await vaults();
    const encoded = "z" + base58.encode(Uint8Array.from([0x80, 0x04, ...new TextEncoder().encode('{"authentication": BROKEN_JSON}')]));
    const broken = `did:peer:4z${base58.encode(Uint8Array.from([0x12, 0x20, ...sha256(new TextEncoder().encode(encoded))]))}:${encoded}` as Did;
    const malformed = resolved(scene, a0.didId, b0, { presentedDid: broken, did: broken.slice(0, broken.lastIndexOf(":")) as Did, authenticationMethodIds: [], keyAgreementMethodIds: [] });
    const genuine = resolved(scene, a0.didId, b0);
    const set = VaultEventSet.of(scene.events);
    expect(set.invalid).toEqual([]);
    const checks = await verifyResolutions(set, noObjects);
    expect(checks.get(malformed.eventId)).toBe("invalid");
    expect(checks.get(genuine.eventId)).toBe("verified");
    await expect(foldVaultChecked(set, null, noObjects)).resolves.toBeDefined();
  });

  it("a snapshot whose presented spelling is not the canonical DID's — another short form, did:web in another case — is not its document's, whatever document it names", async () => {
    const { scene, peerKeys, a0, b0, b2 } = await vaults();
    const objects = new Map([[b0.resolution.cid, b0.resolution.bytes]]);
    const misspelt = resolved(scene, a0.didId, b0, { presentedDid: b2.did });
    const web = await webPeer(peerKeys);
    objects.set(web.resolution.cid, web.bytes);
    const recased = resolved(scene, a0.didId, web, { presentedDid: "did:web:Bob.Example" as Did });
    const exact = resolved(scene, a0.didId, web);
    const checks = await verifyResolutions(VaultEventSet.of(scene.events), readerOf(objects));
    expect(checks.get(misspelt.eventId)).toBe("invalid");
    expect(checks.get(recased.eventId)).toBe("invalid");
    expect(checks.get(exact.eventId)).toBe("verified");
  });

  it("a document read back must be in canonical form: the same did:web document pretty-printed, under its own CID, is no snapshot", async () => {
    const { scene, peerKeys, a0 } = await vaults();
    const canonical = await webPeer(peerKeys);
    const pretty = new TextEncoder().encode(JSON.stringify(canonical.resolution.document, null, 2));
    const cid = rawCidOfBytes(pretty);
    expect(cid).not.toBe(canonical.resolution.cid);
    const web: Peer = { ...canonical, resolution: { ...canonical.resolution, bytes: pretty, cid } };
    const root = resolved(scene, a0.didId, web);
    const readObject = readerOf(new Map([[cid, pretty]]));
    expect((await verifyResolutions(VaultEventSet.of(scene.events), readObject)).get(root.eventId)).toBe("invalid");
    expect((await verifyResolutions(VaultEventSet.of(scene.events), async () => new Uint8Array([1]))).get(root.eventId)).toBe("invalid");
  });
});
