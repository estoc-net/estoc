import type { JsonObject } from "@estoc/event-store/v3";
import { encodeLongForm, longToShort } from "@estoc/did-peer";
import { importSeed } from "@estoc/keystore";
import { base64urlnopad } from "@scure/base";
import { SignJWT, decodeProtectedHeader, importJWK } from "jose";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  InvalidFromPrior,
  KEY_AGREEMENT_METHOD,
  Keys,
  checkDidCreated,
  didKeyName,
  mintDid,
  peerResolution,
  signFromPrior,
  verifyFromPrior,
  type Did,
  type DidId,
  type PinnedResolution,
  type RouteTarget,
} from "../../src/v3/index.js";

const SEED = new Uint8Array(32).fill(7);
const PREDECESSOR = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const SUCCESSOR = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
const ROUTE: RouteTarget = { kind: "mediated", routingDid: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" as Did };
const IAT = 1_757_700_000;

/** The signature the fixed seed puts on the proof; it moves when the derivation, the DIDs or the JWT shape move. */
const EXPECTED_SIGNATURE = "P5uIl87bzVfbgJGbVhmmU5fhH7kF1I2THWRp2y4AJlrvWg7HBzmi6VrKira1ybmBUlrMZPj9AnKvsSc1e6lNBg";

async function setup() {
  const seedKey = await importSeed(SEED);
  const keys = await Keys.open(seedKey, await Keys.anchorOf(seedKey));
  const predecessor = await mintDid(keys, PREDECESSOR, ROUTE);
  const successor = await mintDid(keys, SUCCESSOR, ROUTE);
  const resolution = peerResolution(predecessor.longFormDid);
  const pinned: PinnedResolution = { did: resolution.did, document: resolution.document };
  const jwt = await signFromPrior(keys, predecessor, successor.longFormDid, IAT);
  return { keys, predecessor, successor, pinned, jwt };
}

const segments = (jwt: string) => jwt.split(".") as [string, string, string];
const payloadOf = (jwt: string) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(segments(jwt)[1]))) as JsonObject;

/** The same claims under another protected header or payload, signed by a key of ours. */
async function resign(keys: Keys, didId: DidId, header: Record<string, unknown>, payload: JsonObject): Promise<string> {
  const key = await keys.signing(didKeyName(didId, "authentication"));
  const privateKey = await importJWK(key.privateJwk(), "EdDSA");
  return new SignJWT(payload)
    .setProtectedHeader(header as never)
    .sign(privateKey);
}

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
    const resolution = peerResolution(longFormDid);
    expect((await verifyFromPrior(jwt, { did: resolution.did, document: resolution.document })).methodId).toBe(`${longFormDid}#auth`);
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
    const other = await mintDid(keys, "019b2a70-0000-7000-8000-000000000000" as DidId, ROUTE);
    await expect(signFromPrior(keys, { didId: PREDECESSOR, longFormDid: other.longFormDid }, successor.longFormDid, IAT)).rejects.toThrow(/authorizes no authentication method carrying the entity's key/);
  });
});

describe("verifyFromPrior", () => {
  it("verifies a proof against the pinned predecessor snapshot and returns its claims, the method and the key", async () => {
    const { keys, predecessor, successor, pinned, jwt } = await setup();
    const verified = await verifyFromPrior(jwt, pinned);
    expect(verified).toEqual({
      iss: predecessor.longFormDid,
      sub: successor.longFormDid,
      iat: IAT,
      kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      methodId: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`,
      publicKey: (await keys.didKeys(PREDECESSOR)).authentication.publicKey,
    });
  });

  it("matches DID spellings by validated equivalence: a short-form iss and kid verify against the long-form document, and a long form against a short-form pin", async () => {
    const { keys, predecessor, successor, pinned } = await setup();
    const short = await resign(keys, PREDECESSOR, { alg: "EdDSA", typ: "JWT", kid: `${predecessor.did}${AUTHENTICATION_METHOD}` }, { iss: predecessor.did, sub: successor.longFormDid, iat: IAT });
    expect((await verifyFromPrior(short, pinned)).methodId).toBe(`${predecessor.longFormDid}${AUTHENTICATION_METHOD}`);
    const long = await signFromPrior(keys, predecessor, successor.longFormDid, IAT);
    expect((await verifyFromPrior(long, { did: predecessor.did, document: pinned.document })).iss).toBe(predecessor.longFormDid);
  });

  it("accepts any integer iat, negative or far in the future", async () => {
    const { keys, predecessor, successor, pinned } = await setup();
    for (const iat of [-1, 0, 4_102_444_800]) {
      const jwt = await signFromPrior(keys, predecessor, successor.longFormDid, iat);
      expect((await verifyFromPrior(jwt, pinned)).iat).toBe(iat);
    }
  });

  it("refuses a kid whose DID portion is not iss, or whose method is not an authentication method of the pin", async () => {
    const { keys, predecessor, successor, pinned } = await setup();
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT };
    const otherDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${successor.longFormDid}${AUTHENTICATION_METHOD}` }, claims);
    await expect(verifyFromPrior(otherDid, pinned)).rejects.toThrow(/kid DID portion/);
    const keyAgreement = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${KEY_AGREEMENT_METHOD}` }, claims);
    await expect(verifyFromPrior(keyAgreement, pinned)).rejects.toThrow(/not an authentication method/);
    const otherFragment = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}#key-9` }, claims);
    await expect(verifyFromPrior(otherFragment, pinned)).rejects.toThrow(/not an authentication method/);
    const noFragment = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid: predecessor.longFormDid }, claims);
    await expect(verifyFromPrior(noFragment, pinned)).rejects.toThrow(/not an authentication method/);
  });

  it("refuses an iss that is not the pinned predecessor, and a pin of another document", async () => {
    const { keys, predecessor, successor, pinned, jwt } = await setup();
    const fromSuccessor = await resign(keys, SUCCESSOR, { alg: "EdDSA", kid: `${successor.longFormDid}${AUTHENTICATION_METHOD}` }, { iss: successor.longFormDid, sub: predecessor.longFormDid, iat: IAT });
    await expect(verifyFromPrior(fromSuccessor, pinned)).rejects.toThrow(/not the pinned predecessor/);
    const successorResolution = peerResolution(successor.longFormDid);
    await expect(verifyFromPrior(jwt, { did: successorResolution.did, document: successorResolution.document })).rejects.toThrow(/not the pinned predecessor/);
    await expect(verifyFromPrior(jwt, { did: pinned.did, document: successorResolution.document })).rejects.toThrow(/pinned document is not/);
  });

  it("refuses a pin whose document is another DID's even when that document authorizes a method under the pinned DID", async () => {
    const { predecessor, pinned, jwt } = await setup();
    const method = { id: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`, type: "Multikey", publicKeyMultibase: (pinned.document["verificationMethod"] as JsonObject[])[0]?.["publicKeyMultibase"], controller: predecessor.longFormDid };
    const unrelated = { id: "did:web:unrelated.example", verificationMethod: [method], authentication: [method.id] } as JsonObject;
    await expect(verifyFromPrior(jwt, { did: pinned.did, document: unrelated })).rejects.toThrow(/pinned document is not did:peer:4/);
  });

  it("refuses a sub that is the predecessor under another spelling, or a long form whose hash does not match", async () => {
    const { keys, predecessor, successor, pinned } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const sameDid = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: predecessor.did, iat: IAT });
    await expect(verifyFromPrior(sameDid, pinned)).rejects.toThrow(/sub is another DID/);
    const badHash = `${predecessor.did}:${successor.longFormDid.slice(successor.did.length + 1)}` as Did;
    const badSub = await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, sub: badHash, iat: IAT });
    await expect(verifyFromPrior(badSub, pinned)).rejects.toThrow(/Hash is invalid/);
    await expect(signFromPrior(keys, predecessor, badHash, IAT)).rejects.toThrow(/Hash is invalid/);
  });

  it("refuses a signature that does not verify under the pinned method", async () => {
    const { keys, predecessor, successor, pinned, jwt } = await setup();
    const [header, payload, signature] = segments(jwt);
    const otherPayload = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT + 1 })));
    await expect(verifyFromPrior(`${header}.${otherPayload}.${signature}`, pinned)).rejects.toThrow(/signature does not verify/);
    const bySuccessorKey = await resign(keys, SUCCESSOR, { alg: "EdDSA", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` }, payloadOf(jwt));
    await expect(verifyFromPrior(bySuccessorKey, pinned)).rejects.toThrow(/signature does not verify/);
    expect(payload).toBe(segments(bySuccessorKey)[1]);
  });

  it("refuses another alg, a typ that is not JWT, a kid that is not a DID URL, and claims of the wrong shape", async () => {
    const { keys, predecessor, successor, pinned, jwt } = await setup();
    const kid = `${predecessor.longFormDid}${AUTHENTICATION_METHOD}`;
    const claims = { iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT };
    const [, payload, signature] = segments(jwt);
    const withHeader = (header: JsonObject) => `${base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(header)))}.${payload}.${signature}`;
    await expect(verifyFromPrior(withHeader({ alg: "none", kid }), pinned)).rejects.toThrow(/alg is EdDSA/);
    await expect(verifyFromPrior(withHeader({ alg: "ES256", kid }), pinned)).rejects.toThrow(/alg is EdDSA/);
    await expect(verifyFromPrior(withHeader({ alg: "EdDSA", typ: "JWS", kid }), pinned)).rejects.toThrow(/typ is JWT/);
    await expect(verifyFromPrior(withHeader({ alg: "EdDSA", kid: "key-1" }), pinned)).rejects.toThrow(/kid is a DID URL/);
    await expect(verifyFromPrior(withHeader({ alg: "EdDSA" }), pinned)).rejects.toThrow(/kid is a DID URL/);
    await expect(verifyFromPrior(await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { ...claims, iat: 1.5 }), pinned)).rejects.toThrow(/iat is an integer/);
    await expect(verifyFromPrior(await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { ...claims, iat: "1" }), pinned)).rejects.toThrow(/iat is an integer/);
    await expect(verifyFromPrior(await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { iss: predecessor.longFormDid, iat: IAT }), pinned)).rejects.toThrow(/sub is a DID/);
    await expect(verifyFromPrior(await resign(keys, PREDECESSOR, { alg: "EdDSA", kid }, { sub: successor.longFormDid, iat: IAT }), pinned)).rejects.toThrow(/iss is a DID/);
    await expect(verifyFromPrior("not.a.jwt", pinned)).rejects.toThrow(InvalidFromPrior);
    await expect(verifyFromPrior(`${payload}.${signature}`, pinned)).rejects.toThrow(/compact JWT/);
  });

  it("refuses a proof whose pinned method is not an Ed25519 key", async () => {
    const { predecessor, jwt } = await setup();
    const resolution = peerResolution(predecessor.longFormDid);
    const document = {
      ...resolution.document,
      verificationMethod: [
        { id: KEY_AGREEMENT_METHOD, type: "Multikey", publicKeyMultibase: (resolution.document["verificationMethod"] as JsonObject[])[1]?.["publicKeyMultibase"], controller: predecessor.longFormDid },
      ],
      authentication: [KEY_AGREEMENT_METHOD],
    } as JsonObject;
    const kid = `${predecessor.longFormDid}${KEY_AGREEMENT_METHOD}`;
    const [, payload, signature] = segments(jwt);
    const header = base64urlnopad.encode(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", kid })));
    await expect(verifyFromPrior(`${header}.${payload}.${signature}`, { did: resolution.did, document })).rejects.toThrow(/X25519 key, not Ed25519/);
  });
});
