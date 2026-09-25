import { InvalidFromPrior, verifyFromPrior } from "@estoc/continuity/from-prior";
import { encodeLongForm, longToShort } from "@estoc/did-peer";
import type { JsonObject } from "@estoc/event-store";
import { importSeed } from "@estoc/keystore";
import { base64urlnopad } from "@scure/base";
import { decodeProtectedHeader } from "jose";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  Keys,
  authorizedMethodIds,
  checkDidCreated,
  didKeyName,
  issuerLongFormOf,
  methodPublicKey,
  mintDid,
  peerResolution,
  rawCidOfBytes,
  signFromPrior,
  type Cid,
  type Did,
  type DidId,
  type PeerResolution,
  type RouteTarget,
  type VaultData,
} from "../src/index.js";

const SEED = new Uint8Array(32).fill(7);
const PREDECESSOR = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const SUCCESSOR = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
const OTHER = "019b2a70-0000-7000-8000-000000000000" as DidId;
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
  const jwt = await signFromPrior(keys, predecessor, successor.longFormDid, IAT);
  return { keys, predecessor, successor, resolution, jwt };
}

const segments = (jwt: string) => jwt.split(".") as [string, string, string];
const payloadOf = (jwt: string) => JSON.parse(new TextDecoder().decode(base64urlnopad.decode(segments(jwt)[1]))) as JsonObject;

/** A `peer.resolved` payload retaining a resolution under the spelling the peer presented. */
function retained(resolution: PeerResolution, presentedDid: Did = resolution.presentedDid): { ref: string; data: VaultData["peer.resolved"] } {
  const keyAgreementMethodIds = authorizedMethodIds(resolution.document, "keyAgreement");
  return {
    ref: `resolved:${presentedDid}`,
    data: {
      localKeyName: didKeyName(SUCCESSOR, "key-agreement"),
      peerPublicKey: methodPublicKey(resolution.document, keyAgreementMethodIds[0]!),
      presentedDid,
      did: resolution.did,
      documentCid: resolution.cid,
      authenticationMethodIds: authorizedMethodIds(resolution.document, "authentication"),
      keyAgreementMethodIds,
      service: null,
    },
  };
}

const noObjects = async () => null;
const readerOf = (objects: Map<Cid, Uint8Array>) => async (wanted: Cid) => objects.get(wanted) ?? null;

describe("signFromPrior", () => {
  it("issues a compact EdDSA JWT whose iss and kid are the predecessor's long form and whose sub is the successor's, verified against the predecessor's document", async () => {
    const { predecessor, successor, jwt } = await setup();
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "EdDSA", typ: "JWT", kid: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` });
    expect(payloadOf(jwt)).toEqual({ iss: predecessor.longFormDid, sub: successor.longFormDid, iat: IAT });
    expect(segments(jwt)[2]).toBe(EXPECTED_SIGNATURE);
    const verified = await verifyFromPrior(jwt, { ref: "document", longForm: predecessor.longFormDid });
    expect(verified).toMatchObject({ issuer: { presented: predecessor.longFormDid, canonical: predecessor.did }, change: { kind: "rotate", successor: { presented: successor.longFormDid, canonical: successor.did } }, iat: IAT, method: `${predecessor.longFormDid}${AUTHENTICATION_METHOD}` });
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
    expect((await verifyFromPrior(jwt, { ref: "document", longForm: longFormDid })).method).toBe(`${longFormDid}#auth`);
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

describe("issuerLongFormOf", () => {
  it("takes a long-form issuer as its own evidence, reading nothing", async () => {
    const { predecessor } = await setup();
    const readObject = async () => {
      throw new Error("no object is read");
    };
    expect(await issuerLongFormOf(predecessor.longFormDid, [], readObject)).toEqual({ ref: predecessor.longFormDid, longForm: predecessor.longFormDid });
  });

  it("finds a short-form issuer's long form in a retained resolution of that DID: from the presented long form at once, from a presented short form once the document is here", async () => {
    const { predecessor, successor, resolution } = await setup();
    const other = peerResolution(successor.longFormDid);
    expect(await issuerLongFormOf(predecessor.did, [], noObjects)).toBeNull();
    expect(await issuerLongFormOf(predecessor.did, [retained(other)], noObjects)).toBeNull();
    expect(await issuerLongFormOf(predecessor.did, [retained(resolution)], noObjects)).toEqual({ ref: `resolved:${predecessor.longFormDid}`, longForm: predecessor.longFormDid });
    expect(await issuerLongFormOf(predecessor.did, [retained(resolution, predecessor.did)], noObjects)).toBeNull();
    const readObject = readerOf(new Map([[resolution.cid, resolution.bytes]]));
    expect(await issuerLongFormOf(predecessor.did, [retained(other), retained(resolution, predecessor.did)], readObject)).toEqual({ ref: `resolved:${predecessor.did}`, longForm: predecessor.longFormDid });
  });

  it("passes over a retained resolution whose object is not the document it names", async () => {
    const { predecessor, successor, resolution } = await setup();
    const other = peerResolution(successor.longFormDid);
    const forged = retained(resolution, predecessor.did);
    forged.data = { ...forged.data, documentCid: rawCidOfBytes(other.bytes) };
    const readObject = readerOf(new Map([[forged.data.documentCid, other.bytes], [resolution.cid, resolution.bytes]]));
    expect(await issuerLongFormOf(predecessor.did, [forged], readObject)).toBeNull();
    expect(await issuerLongFormOf(predecessor.did, [forged, retained(resolution, predecessor.did)], readObject)).toEqual({ ref: `resolved:${predecessor.did}`, longForm: predecessor.longFormDid });
  });
});
