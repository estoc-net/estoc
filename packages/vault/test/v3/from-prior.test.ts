import type { JsonObject } from "@estoc/event-store/v3";
import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { importSeed } from "@estoc/keystore";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64urlnopad } from "@scure/base";
import { FlattenedSign, SignJWT, decodeProtectedHeader, importJWK } from "jose";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  InvalidFromPrior,
  KEY_AGREEMENT_METHOD,
  Keys,
  authorizedMethodIds,
  carriedClaims,
  checkDidCreated,
  didKeyName,
  fromPriorClaims,
  issuerDocumentOf,
  methodPublicKey,
  mintDid,
  peerResolution,
  rawCidOfBytes,
  signFromPrior,
  verifyFromPrior,
  verifyLocalProof,
  type Cid,
  type Did,
  type DidId,
  type PeerResolution,
  type RouteTarget,
  type VaultData,
} from "../../src/v3/index.js";

const SEED = new Uint8Array(32).fill(7);
const PREDECESSOR = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const SUCCESSOR = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
const OTHER = "019b2a70-0000-7000-8000-000000000000" as DidId;
const ROUTE: RouteTarget = { kind: "mediated", routingDid: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" as Did };
const IAT = 1_757_700_000;
const WEB_DID = "did:web:bob.example" as Did;

/** The signature the fixed seed puts on the proof; it moves when the derivation, the DIDs or the JWT shape move. */
const EXPECTED_SIGNATURE = "P5uIl87bzVfbgJGbVhmmU5fhH7kF1I2THWRp2y4AJlrvWg7HBzmi6VrKira1ybmBUlrMZPj9AnKvsSc1e6lNBg";

async function setup() {
  const seedKey = await importSeed(SEED);
  const keys = await Keys.open(seedKey, await Keys.anchorOf(seedKey));
  const predecessor = await mintDid(keys, PREDECESSOR, ROUTE);
  const successor = await mintDid(keys, SUCCESSOR, ROUTE);
  const resolution = peerResolution(predecessor.longFormDid);
  const document = resolution.document;
  const jwt = await signFromPrior(keys, predecessor, successor.longFormDid, IAT);
  return { keys, predecessor, successor, resolution, document, jwt };
}

const segments = (jwt: string) => jwt.split(".") as [string, string, string];
const payloadOf = (jwt: string) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(segments(jwt)[1]))) as JsonObject;
const encode = (value: unknown) => base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));

/** The same claims under another protected header or payload, signed by a key of ours. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  const privateKey = await importJWK(key.privateJwk(), "EdDSA");
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(privateKey);
}

/** A `peer.resolved` payload retaining a resolution under the spelling the peer presented. */
function retained(resolution: PeerResolution, presentedDid: Did = resolution.presentedDid): VaultData["peer.resolved"] {
  const keyAgreementMethodIds = authorizedMethodIds(resolution.document, "keyAgreement");
  return {
    localKeyName: didKeyName(SUCCESSOR, "key-agreement"),
    peerPublicKey: methodPublicKey(resolution.document, keyAgreementMethodIds[0]!),
    presentedDid,
    did: resolution.did,
    documentCid: resolution.cid,
    authenticationMethodIds: authorizedMethodIds(resolution.document, "authentication"),
    keyAgreementMethodIds,
    service: null,
  };
}

/** A long form over exact document bytes, hash and all: what only a hand-built encoder can put on the wire. */
function longFormOfBytes(json: string): Did {
  const encoded = "z" + base58.encode(Uint8Array.from([0x80, 0x04, ...new TextEncoder().encode(json)]));
  const hash = "z" + base58.encode(Uint8Array.from([0x12, 0x20, ...sha256(new TextEncoder().encode(encoded))]));
  return `did:peer:4${hash}:${encoded}` as Did;
}

/** A JWS over the unencoded payload segment, signed by a key of ours: what a JWT may not be. */
async function unencodedPayload(keys: Keys, didId: DidId, kid: string, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  const privateKey = await importJWK(key.privateJwk(), "EdDSA");
  const segment = encode(payload);
  const signed = await new FlattenedSign(new TextEncoder().encode(segment))
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid, b64: false, crit: ["b64"] })
    .sign(privateKey);
  return `${signed.protected}.${segment}.${signed.signature}`;
}

const noObjects = async () => null;
const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;

describe("signFromPrior", () => {
  it("issues a compact EdDSA JWT whose iss and kid are the predecessor's long form and whose sub is the successor's", async () => {
    const { predecessor, successor, jwt } = await setup();
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "EdDSA", typ: "JWT", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` });
    expect(payloadOf(jwt)).toEqual({ iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT });
    expect(segments(jwt)[2]).toBe(EXPECTED_SIGNATURE);
  });

  it("refuses a short form on either side, the same DID on both, and a non-integer iat", async () => {
    const { keys, predecessor, successor } = await setup();
    await expect(signFromPrior(keys, { didId: PREDECESSOR, longFormDid: predecessor.did }, successor.longFormDid, IAT)).rejects.toThrow(InvalidFromPrior);
    await expect(signFromPrior(keys, predecessor, successor.did, IAT)).rejects.toThrow(InvalidFromPrior);
    await expect(signFromPrior(keys, predecessor, predecessor.longFormDid, IAT)).rejects.toThrow(InvalidFromPrior);
    await expect(signFromPrior(keys, predecessor, successor.longFormDid, 1.5)).rejects.toThrow(InvalidFromPrior);
  });
});

describe("signFromPrior over a recorded document", () => {
  it("names the method the predecessor's own document gives its authentication key, whatever its fragment, so the proof verifies against that document", async () => {
    const { keys, successor } = await setup();
    const { inputDocument } = await mintDid(keys, PREDECESSOR, ROUTE);
    const methods = inputDocument["verificationMethod"] as JsonObject[];
    const renamed: JsonObject = { ...inputDocument, verificationMethod: [{ ...(methods[0] as JsonObject), id: "#auth" }, { ...(methods[1] as JsonObject), id: "#agree" }], authentication: ["#auth"], keyAgreement: ["#agree"] };
    const longFormDid = encodeLongForm(renamed) as Did;
    const recorded = { didId: PREDECESSOR, did: longToShort(longFormDid) as Did, longFormDid };
    await checkDidCreated(keys, recorded, ROUTE);
    const jwt = await signFromPrior(keys, recorded, successor.longFormDid, IAT);
    expect(decodeProtectedHeader(jwt).kid).toBe(`${longFormDid}#auth`);
    expect((await verifyFromPrior(jwt, peerResolution(longFormDid).document)).methodId).toBe(`${longFormDid}#auth`);
    expect((await verifyLocalProof(jwt, keys, recorded, successor.longFormDid)).methodId).toBe(`${longFormDid}#auth`);
  });

  it("refuses a recorded predecessor whose document leaks the entity's private key, and signs nothing for it", async () => {
    const { keys, successor } = await setup();
    const { inputDocument } = await mintDid(keys, PREDECESSOR, ROUTE);
    const { authentication } = await keys.didKeys(PREDECESSOR);
    const methods = inputDocument["verificationMethod"] as JsonObject[];
    const leaking: JsonObject = { ...inputDocument, verificationMethod: [{ id: "#key-1", type: "JsonWebKey2020", publicKeyJwk: authentication.privateJwk() }, methods[1] as JsonObject] };
    const longFormDid = encodeLongForm(leaking) as Did;
    const recorded = { didId: PREDECESSOR, did: longToShort(longFormDid) as Did, longFormDid };
    await expect(checkDidCreated(keys, recorded, ROUTE)).rejects.toThrow(/without the private member d/);
    await expect(signFromPrior(keys, recorded, successor.longFormDid, IAT)).rejects.toThrow(InvalidFromPrior);
    await expect(signFromPrior(keys, recorded, successor.longFormDid, IAT)).rejects.toThrow(/without the private member d/);
  });

  it("refuses to sign for a predecessor whose document does not carry the entity's authentication key", async () => {
    const { keys, successor } = await setup();
    const other = await mintDid(keys, OTHER, ROUTE);
    await expect(signFromPrior(keys, { didId: PREDECESSOR, longFormDid: other.longFormDid }, successor.longFormDid, IAT)).rejects.toThrow(/authorizes no authentication method carrying the entity's key/);
  });
});

describe("fromPriorClaims", () => {
  it("reads the claims and the protected kid without verifying anything, a broken signature included", async () => {
    const { predecessor, successor, jwt } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT, kid };
    expect(fromPriorClaims(jwt)).toEqual(claims);
    const [header, payload] = segments(jwt);
    expect(fromPriorClaims(`${header}.${payload}.AAAA`)).toEqual(claims);
  });

  it("refuses another alg, a typ that is not JWT, a kid that is not a DID URL, and claims of the wrong shape", async () => {
    const { keys, predecessor, successor, jwt } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT };
    const [, payload, signature] = segments(jwt);
    const withHeader = (header: JsonObject) => `${encode(header)}.${payload}.${signature}`;
    expect(() => fromPriorClaims(withHeader({ alg: "none", kid }))).toThrow(/alg is EdDSA/);
    expect(() => fromPriorClaims(withHeader({ alg: "ES256", kid }))).toThrow(/alg is EdDSA/);
    expect(() => fromPriorClaims(withHeader({ alg: "EdDSA", typ: "JWS", kid }))).toThrow(/typ is JWT/);
    expect(() => fromPriorClaims(withHeader({ alg: "EdDSA", kid: "key-1" }))).toThrow(/kid is a DID URL/);
    expect(() => fromPriorClaims(withHeader({ alg: "EdDSA" }))).toThrow(/kid is a DID URL/);
    expect(() => fromPriorClaims(`${encode([])}.${payload}.${signature}`)).toThrow(/protected header is a JSON object/);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid, crit: ["kid"] })}.${payload}.${signature}`)).toThrow(/names no critical header/);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid, b64: true })}.${payload}.${signature}`)).toThrow(/encodes its payload/);
    const signed = async (payload: JsonObject) => resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, payload);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid })}.${encode({ ...claims, iat: 1.5 })}.${signature}`)).toThrow(/iat is an integer/);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid })}.${encode({ ...claims, iat: "1" })}.${signature}`)).toThrow(/iat is an integer/);
    const noSub = await signed({ iss: predecessor.longFormDid, iat: IAT });
    expect(() => fromPriorClaims(noSub)).toThrow(/sub is a DID/);
    const noIss = await signed({ sub: successor.longFormDid, iat: IAT });
    expect(() => fromPriorClaims(noIss)).toThrow(/iss is a DID/);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid })}.${encode([1])}.${signature}`)).toThrow(/payload is a JSON object/);
    expect(() => fromPriorClaims(`${encode({ alg: "EdDSA", kid })}.${base64urlnopad.encode(new Uint8Array([0xff]))}.${signature}`)).toThrow(/payload is not JSON/);
    expect(() => fromPriorClaims("not.a.jwt")).toThrow(InvalidFromPrior);
    expect(() => fromPriorClaims(`${payload}.${signature}`)).toThrow(/compact JWT/);
    expect(() => fromPriorClaims("")).toThrow(/compact JWT/);
  });

  it("refuses a segment that is not base64url, the signature included, before any issuer material is asked for", async () => {
    const { keys, predecessor, successor, jwt } = await setup();
    const [header, payload, signature] = segments(jwt);
    expect(() => fromPriorClaims(`A.${payload}.${signature}`)).toThrow(/protected header is not base64url/);
    expect(() => fromPriorClaims(`${header}.A.${signature}`)).toThrow(/payload is not base64url/);
    expect(() => fromPriorClaims(`${header}.${payload}.A`)).toThrow(/signature is not base64url/);
    const short = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, { iss: predecessor.did, sub: successor.longFormDid, iat: IAT });
    const [shortHeader, shortPayload] = segments(short);
    expect(() => carriedClaims(`${shortHeader}.${shortPayload}.A`, successor.longFormDid)).toThrow(/signature is not base64url/);
  });

  it("refuses a JWS over an unencoded payload, which a JWT may not be, on every path", async () => {
    const { keys, predecessor, successor, document } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const unencoded = await unencodedPayload(keys, PREDECESSOR, kid, { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT });
    expect(() => fromPriorClaims(unencoded)).toThrow(/encodes its payload/);
    expect(() => carriedClaims(unencoded, successor.longFormDid)).toThrow(/encodes its payload/);
    await expect(verifyFromPrior(unencoded, document)).rejects.toThrow(/encodes its payload/);
    await expect(verifyLocalProof(unencoded, keys, predecessor, successor.longFormDid)).rejects.toThrow(/encodes its payload/);
  });
});

describe("carriedClaims", () => {
  it("derives the canonical DIDs a proof links from a long-form or a short-form issuer, without touching the signature", async () => {
    const { keys, predecessor, successor, jwt } = await setup();
    const [header, payload] = segments(jwt);
    expect(carriedClaims(`${header}.${payload}.AAAA`, successor.longFormDid)).toEqual({ ...fromPriorClaims(jwt), predecessorDid: predecessor.did, successorDid: successor.did });
    const short = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, { iss: predecessor.did, sub: successor.longFormDid, iat: IAT });
    expect(carriedClaims(short, successor.longFormDid)).toMatchObject({ iss: predecessor.did, predecessorDid: predecessor.did, successorDid: successor.did });
    const shortSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: predecessor.longFormDid, sub: successor.did, iat: IAT });
    expect(carriedClaims(shortSub, successor.did)).toMatchObject({ sub: successor.did, successorDid: successor.did });
  });

  it("refuses a sub that is not the DID the message came from, byte for byte", async () => {
    const { successor, jwt } = await setup();
    expect(() => carriedClaims(jwt, successor.did)).toThrow(/the DID the message came from/);
    expect(() => carriedClaims(jwt, WEB_DID)).toThrow(/the DID the message came from/);
  });

  it("refuses an iss or sub that is not a did:peer:4, a long form whose hash does not match, and the same DID under two spellings", async () => {
    const { keys, predecessor, successor } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const webIss = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${WEB_DID}#key-1` }, { iss: WEB_DID, sub: successor.longFormDid, iat: IAT });
    expect(() => carriedClaims(webIss, successor.longFormDid)).toThrow(/iss is a did:peer:4/);
    const webSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: WEB_DID, iat: IAT });
    expect(() => carriedClaims(webSub, WEB_DID)).toThrow(/sub is a did:peer:4/);
    const badHash = `${predecessor.did}:${successor.longFormDid.slice(successor.did.length + 1)}` as Did;
    const badIss = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${badHash}${AUTHENTICATION_METHOD}` }, { iss: badHash, sub: successor.longFormDid, iat: IAT });
    expect(() => carriedClaims(badIss, successor.longFormDid)).toThrow(/Hash is invalid/);
    const badSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: badHash, iat: IAT });
    expect(() => carriedClaims(badSub, badHash)).toThrow(/Hash is invalid/);
    const sameDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: predecessor.did, iat: IAT });
    expect(() => carriedClaims(sameDid, predecessor.did)).toThrow(/sub is another DID than iss/);
  });

  it("finds a long form invalid whose hash is right but whose encoded document is not JSON, wherever it appears", async () => {
    const { keys, successor, resolution } = await setup();
    const broken = longFormOfBytes('{"authentication": BROKEN_JSON}');
    const brokenShort = broken.slice(0, broken.lastIndexOf(":")) as Did;
    const asIssuer = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${broken}${AUTHENTICATION_METHOD}` }, { iss: broken, sub: successor.longFormDid, iat: IAT });
    expect(() => carriedClaims(asIssuer, successor.longFormDid)).toThrow(/encoded document is not JSON/);
    expect(() => carriedClaims(asIssuer, successor.longFormDid)).toThrow(InvalidFromPrior);
    const asSuccessor = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${resolution.presentedDid}${AUTHENTICATION_METHOD}` }, { iss: resolution.presentedDid, sub: broken, iat: IAT });
    expect(() => carriedClaims(asSuccessor, broken)).toThrow(InvalidFromPrior);
    await expect(issuerDocumentOf(broken, [], noObjects)).rejects.toThrow(InvalidFromPrior);
    const retainedBroken = { ...retained(resolution), presentedDid: broken, did: brokenShort, authenticationMethodIds: [], keyAgreementMethodIds: [] };
    expect(await issuerDocumentOf(brokenShort, [retainedBroken], noObjects)).toBeNull();
  });

  it("refuses a kid whose DID portion is not iss byte for byte, even another spelling of it", async () => {
    const { keys, predecessor, successor } = await setup();
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT };
    const otherDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${successor.longFormDid}${AUTHENTICATION_METHOD}` }, claims);
    expect(() => carriedClaims(otherDid, successor.longFormDid)).toThrow(/kid DID portion/);
    const shortKid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, claims);
    expect(() => carriedClaims(shortKid, successor.longFormDid)).toThrow(/kid DID portion/);
    expect(() => carriedClaims("not.a.jwt", successor.longFormDid)).toThrow(InvalidFromPrior);
  });
});

describe("issuerDocumentOf", () => {
  it("derives a long-form issuer's document from the spelling alone", async () => {
    const { predecessor, resolution } = await setup();
    const readObject = async () => {
      throw new Error("no object is read");
    };
    expect(await issuerDocumentOf(predecessor.longFormDid, [], readObject)).toEqual(resolution.document);
  });

  it("finds a short-form issuer's document in a retained resolution of that DID, under either presented spelling, and only once the object is here", async () => {
    const { predecessor, successor, resolution } = await setup();
    const other = peerResolution(successor.longFormDid);
    expect(await issuerDocumentOf(predecessor.did, [], noObjects)).toBeNull();
    expect(await issuerDocumentOf(predecessor.did, [retained(other)], noObjects)).toBeNull();
    expect(await issuerDocumentOf(predecessor.did, [retained(resolution)], noObjects)).toEqual(resolution.document);
    expect(await issuerDocumentOf(predecessor.did, [retained(resolution, predecessor.did)], noObjects)).toBeNull();
    const readObject = readerOf(new Map([[resolution.cid, resolution.bytes]]));
    expect(await issuerDocumentOf(predecessor.did, [retained(other), retained(resolution, predecessor.did)], readObject)).toEqual(resolution.document);
  });

  it("passes over a retained resolution whose object is not the document it names", async () => {
    const { predecessor, successor, resolution } = await setup();
    const other = peerResolution(successor.longFormDid);
    const forged = { ...retained(resolution, predecessor.did), documentCid: rawCidOfBytes(other.bytes) };
    const readObject = readerOf(new Map([[forged.documentCid, other.bytes], [resolution.cid, resolution.bytes]]));
    expect(await issuerDocumentOf(predecessor.did, [forged], readObject)).toBeNull();
    expect(await issuerDocumentOf(predecessor.did, [forged, retained(resolution, predecessor.did)], readObject)).toEqual(resolution.document);
  });

  it("refuses a long form that does not resolve", async () => {
    const { predecessor, successor } = await setup();
    const badHash = `${predecessor.did}:${successor.longFormDid.slice(successor.did.length + 1)}` as Did;
    await expect(issuerDocumentOf(badHash, [], noObjects)).rejects.toThrow(InvalidFromPrior);
  });
});

describe("verifyFromPrior", () => {
  it("verifies a proof against the issuer's document and returns its claims, the method and the key", async () => {
    const { keys, predecessor, successor, document, jwt } = await setup();
    expect(await verifyFromPrior(jwt, document)).toEqual({
      iss: predecessor.longFormDid,
      sub: successor.longFormDid,
      iat: IAT,
      kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      methodId: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      publicKey: (await keys.didKeys(PREDECESSOR)).authentication.publicKey,
    });
  });

  it("matches DID spellings by validated equivalence: a short-form iss and kid verify against the long-form document", async () => {
    const { keys, predecessor, successor, document } = await setup();
    const short = await resign(keys, PREDECESSOR, { alg: "EdDSA", typ: "JWT", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, { iss: predecessor.did, sub: successor.longFormDid, iat: IAT });
    expect((await verifyFromPrior(short, document)).methodId).toBe(`${predecessor.longFormDid}${AUTHENTICATION_METHOD}`);
  });

  it("accepts any integer iat, negative or far in the future", async () => {
    const { keys, predecessor, successor, document } = await setup();
    for (const iat of [-1, 0, 4_102_444_800]) {
      const jwt = await signFromPrior(keys, predecessor, successor.longFormDid, iat);
      expect((await verifyFromPrior(jwt, document)).iat).toBe(iat);
    }
  });

  it("refuses a kid whose DID portion is not iss, or whose method is not an authentication method of the document", async () => {
    const { keys, predecessor, successor, document } = await setup();
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT };
    const otherDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${successor.longFormDid}${AUTHENTICATION_METHOD}` }, claims);
    await expect(verifyFromPrior(otherDid, document)).rejects.toThrow(/kid DID portion/);
    const keyAgreement = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${KEY_AGREEMENT_METHOD}` }, claims);
    await expect(verifyFromPrior(keyAgreement, document)).rejects.toThrow(/not an authentication method/);
    const otherFragment = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}#key-9` }, claims);
    await expect(verifyFromPrior(otherFragment, document)).rejects.toThrow(/not an authentication method/);
    const noFragment = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: predecessor.longFormDid }, claims);
    await expect(verifyFromPrior(noFragment, document)).rejects.toThrow(/not an authentication method/);
  });

  it("refuses a document that is not the issuer's, even one authorizing a method under the issuer's DID", async () => {
    const { keys, predecessor, successor, document, jwt } = await setup();
    const fromSuccessor = await resign(keys, SUCCESSOR, { alg: "EdDSA", kid: `${successor.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: successor.longFormDid, sub: predecessor.longFormDid, iat: IAT });
    await expect(verifyFromPrior(fromSuccessor, document)).rejects.toThrow(/document is not/);
    await expect(verifyFromPrior(jwt, peerResolution(successor.longFormDid).document)).rejects.toThrow(/document is not/);
    const method = { id: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`, type: "Multikey", publicKeyMultibase: (document["verificationMethod"] as JsonObject[])[0]?.["publicKeyMultibase"], controller: predecessor.longFormDid };
    const unrelated = { id: WEB_DID, verificationMethod: [method], authentication: [method.id] } as JsonObject;
    await expect(verifyFromPrior(jwt, unrelated)).rejects.toThrow(/document is not did:peer:4/);
    await expect(verifyFromPrior(jwt, { ...document, id: "not a did" })).rejects.toThrow(/document is not did:peer:4/);
  });

  it("refuses a sub that is the issuer under another spelling, or a long form whose hash does not match", async () => {
    const { keys, predecessor, successor, document } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const sameDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: predecessor.did, iat: IAT });
    await expect(verifyFromPrior(sameDid, document)).rejects.toThrow(/sub is another DID/);
    const badHash = `${predecessor.did}:${successor.longFormDid.slice(successor.did.length + 1)}` as Did;
    const badSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: badHash, iat: IAT });
    await expect(verifyFromPrior(badSub, document)).rejects.toThrow(/Hash is invalid/);
    await expect(signFromPrior(keys, predecessor, badHash, IAT)).rejects.toThrow(/Hash is invalid/);
  });

  it("refuses a signature that does not verify under the named method", async () => {
    const { keys, predecessor, successor, document, jwt } = await setup();
    const [header, payload, signature] = segments(jwt);
    const otherPayload = encode({ iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT + 1 });
    await expect(verifyFromPrior(`${header}.${otherPayload}.${signature}`, document)).rejects.toThrow(/signature does not verify/);
    const bySuccessorKey = await resign(keys, SUCCESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` }, payloadOf(jwt));
    await expect(verifyFromPrior(bySuccessorKey, document)).rejects.toThrow(/signature does not verify/);
    expect(payload).toBe(segments(bySuccessorKey)[1]);
    await expect(verifyFromPrior("not.a.jwt", document)).rejects.toThrow(InvalidFromPrior);
  });

  it("refuses a proof whose named method is not an Ed25519 key", async () => {
    const { predecessor, document: resolved, jwt } = await setup();
    const document = {
      ...resolved,
      verificationMethod: [
        { id: KEY_AGREEMENT_METHOD, type: "Multikey", publicKeyMultibase: (resolved["verificationMethod"] as JsonObject[])[1]?.["publicKeyMultibase"], controller: predecessor.longFormDid },
      ],
      authentication: [KEY_AGREEMENT_METHOD],
    } as JsonObject;
    const kid = `${predecessor.longFormDid}${KEY_AGREEMENT_METHOD}`;
    const [, payload, signature] = segments(jwt);
    await expect(verifyFromPrior(`${encode({ alg: "EdDSA", kid })}.${payload}.${signature}`, document)).rejects.toThrow(/X25519 key, not Ed25519/);
  });
});

describe("verifyLocalProof", () => {
  it("verifies the proof a rotation decision froze against the predecessor's document and the seed", async () => {
    const { keys, predecessor, successor, jwt } = await setup();
    expect(await verifyLocalProof(jwt, keys, predecessor, successor.longFormDid)).toEqual({
      iss: predecessor.longFormDid,
      sub: successor.longFormDid,
      iat: IAT,
      kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      methodId: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      publicKey: (await keys.didKeys(PREDECESSOR)).authentication.publicKey,
    });
  });

  it("requires the exact long forms of the two entities, where a peer's proof may use a short form", async () => {
    const { keys, predecessor, successor, document, jwt } = await setup();
    const short = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, { iss: predecessor.did, sub: successor.longFormDid, iat: IAT });
    await expect(verifyFromPrior(short, document)).resolves.toBeDefined();
    await expect(verifyLocalProof(short, keys, predecessor, successor.longFormDid)).rejects.toThrow(/predecessor's long form/);
    await expect(verifyLocalProof(short, keys, { didId: PREDECESSOR, longFormDid: predecessor.did }, successor.longFormDid)).rejects.toThrow(/long forms/);
    const shortSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: predecessor.longFormDid, sub: successor.did, iat: IAT });
    await expect(verifyFromPrior(shortSub, document)).resolves.toBeDefined();
    await expect(verifyLocalProof(shortSub, keys, predecessor, successor.longFormDid)).rejects.toThrow(/successor's long form/);
    await expect(verifyLocalProof(jwt, keys, predecessor, successor.did)).rejects.toThrow(/successor's long form/);
    await expect(verifyLocalProof(jwt, keys, { didId: PREDECESSOR, longFormDid: successor.longFormDid }, predecessor.longFormDid)).rejects.toThrow(/predecessor's long form/);
  });

  it("refuses a proof the predecessor's document verifies under a key that is not the entity's", async () => {
    const { keys, successor } = await setup();
    const other = await mintDid(keys, OTHER, ROUTE);
    const jwt = await resign(keys, OTHER, { alg: "EdDSA", kid: `${other.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: other.longFormDid, sub: successor.longFormDid, iat: IAT });
    await expect(verifyFromPrior(jwt, peerResolution(other.longFormDid).document)).resolves.toBeDefined();
    await expect(verifyLocalProof(jwt, keys, { didId: PREDECESSOR, longFormDid: other.longFormDid }, successor.longFormDid)).rejects.toThrow(/does not carry the entity's authentication key/);
    await expect(verifyLocalProof(jwt, keys, { didId: OTHER, longFormDid: other.longFormDid }, successor.longFormDid)).resolves.toBeDefined();
  });

  it("refuses a signature that does not verify and a malformed JWT", async () => {
    const { keys, predecessor, successor, jwt } = await setup();
    const [header, payload] = segments(jwt);
    await expect(verifyLocalProof(`${header}.${payload}.AAAA`, keys, predecessor, successor.longFormDid)).rejects.toThrow(/signature does not verify/);
    await expect(verifyLocalProof("not.a.jwt", keys, predecessor, successor.longFormDid)).rejects.toThrow(InvalidFromPrior);
  });
});
