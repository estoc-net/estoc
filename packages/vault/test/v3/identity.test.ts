import type { JsonObject } from "@estoc/event-store/v3";
import { decodeLongForm, encodeLongForm, isLongForm, longToShort } from "@estoc/did-peer";
import { createSeedKeystore, deriveIdentity, importSeed } from "@estoc/keystore";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  AUTHENTICATION_METHOD,
  IdentityMismatch,
  InvalidDidDocument,
  KEY_AGREEMENT_METHOD,
  Keys,
  Locked,
  authorizedMethodIds,
  checkDidCreated,
  checkMediationCreated,
  decodePublicKey,
  didKeyName,
  mediationKeyName,
  methodPublicKey,
  mintDid,
  mintMediationDid,
  peerResolution,
  type Did,
  type DidId,
  type KeyName,
  type MediationId,
  type RouteTarget,
} from "../../src/v3/index.js";

const SEED = new Uint8Array(32).fill(7);
const OTHER_SEED = new Uint8Array(32).fill(8);
const DID_ID = "019b2a54-05bd-74ef-b8ac-e8375cb776c2" as DidId;
const DID_ID2 = "019b2a60-c68e-75bf-b6fb-ae1a41f8d715" as DidId;
const MEDIATION = "019b2a51-118f-7e46-b31b-c63cd090c92c" as MediationId;
const MEDIATED: RouteTarget = { kind: "mediated", routingDid: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc" as Did };
const DIRECT: RouteTarget = { kind: "direct", endpoint: "https://ingress.example/didcomm" };

/** The anchor and the DIDs the fixed seed derives; a change here renames every identity a vault holds. */
const EXPECTED = {
  anchor: "did:key:z6MknPaqk9immiDFicttb6PNyNEc3B2f28DxSoYKbEvaNvqL",
  mediatedShort: "did:peer:4zQmaszWy5nSWq5GjKaGPuRCuFfwBqML1SAQNxPJdpAxx3fP",
  directShort: "did:peer:4zQmcRRbHFBJtMfjVL6ycfrhWYviwcCZPT95vriF6JMSpye5",
  mediationShort: "did:peer:4zQmdxb4gk3GmReVxbUhThVG4hAfKTmF2jTf2cGdHZryz1xC",
};

async function open(seed = SEED): Promise<Keys> {
  const seedKey = await importSeed(seed);
  return Keys.open(seedKey, await Keys.anchorOf(seedKey));
}

describe("Keys", () => {
  it("derives one anchor per seed and opens only over the seed that derives the vault's", async () => {
    const seedKey = await importSeed(SEED);
    expect(await Keys.anchorOf(seedKey)).toBe(EXPECTED.anchor);
    expect(await Keys.anchorOf(await importSeed(OTHER_SEED))).not.toBe(EXPECTED.anchor);
    await expect(Keys.open(seedKey, "did:key:z6MkOther")).rejects.toThrow(IdentityMismatch);
    expect((await Keys.open(seedKey, EXPECTED.anchor)).locked).toBe(false);
  });

  it("unlocks the keystore package's wrapped seed with the passphrase", async () => {
    const { doc } = await createSeedKeystore("open sesame", { seed: SEED });
    const keys = await Keys.unlock({ version: 3, seedJwe: doc.seedJwe }, "open sesame", EXPECTED.anchor);
    expect((await keys.didKeys(DID_ID)).authentication.publicKey).toBe((await (await open()).didKeys(DID_ID)).authentication.publicKey);
    await expect(Keys.unlock({ version: 3, seedJwe: doc.seedJwe }, "wrong", EXPECTED.anchor)).rejects.toThrow(/passphrase/);
  });

  it("derives the two keys of a DID entity under their reserved names, each usable with its private half", async () => {
    const keys = await open();
    const { authentication, keyAgreement } = await keys.didKeys(DID_ID);
    expect(authentication.name).toBe(`did/${DID_ID}/authentication`);
    expect(keyAgreement.name).toBe(`did/${DID_ID}/key-agreement`);
    expect(decodePublicKey(authentication.publicKey)).toEqual({ type: "Ed25519", bytes: authentication.publicKeyBytes() });
    expect(decodePublicKey(keyAgreement.publicKey)).toEqual({ type: "X25519", bytes: keyAgreement.publicKeyBytes() });

    const signing = authentication.privateJwk();
    expect(signing).toMatchObject({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(authentication.publicKeyBytes()) });
    expect(ed25519.getPublicKey(base64urlnopad.decode(signing.d))).toEqual(authentication.publicKeyBytes());
    const agreement = keyAgreement.privateJwk();
    expect(agreement).toMatchObject({ kty: "OKP", crv: "X25519", x: base64urlnopad.encode(keyAgreement.publicKeyBytes()) });
    expect(x25519.getPublicKey(base64urlnopad.decode(agreement.d))).toEqual(keyAgreement.publicKeyBytes());
  });

  it("takes a key-agreement key from the keystore's own X25519 derivation of the name, not from its Ed25519 key", async () => {
    const seedKey = await importSeed(SEED);
    const keys = await Keys.open(seedKey, EXPECTED.anchor);
    const name = didKeyName(DID_ID, "key-agreement");
    const derived = await deriveIdentity(seedKey, name);
    expect((await keys.agreement(name)).publicKeyBytes()).toEqual(derived.signer.x25519PublicKey());
    expect((await keys.signing(name)).publicKeyBytes()).toEqual(derived.signer.publicKey());
    expect((await keys.agreement(name)).publicKey).not.toBe((await keys.agreement(didKeyName(DID_ID, "authentication"))).publicKey);
  });

  it("derives a mediation arrangement's one name in both uses", async () => {
    const seedKey = await importSeed(SEED);
    const keys = await Keys.open(seedKey, EXPECTED.anchor);
    const { authentication, keyAgreement } = await keys.mediationKeys(MEDIATION);
    expect(authentication.name).toBe(mediationKeyName(MEDIATION));
    expect(keyAgreement.name).toBe(mediationKeyName(MEDIATION));
    const derived = await deriveIdentity(seedKey, mediationKeyName(MEDIATION));
    expect(authentication.publicKeyBytes()).toEqual(derived.signer.publicKey());
    expect(keyAgreement.publicKeyBytes()).toEqual(derived.signer.x25519PublicKey());
  });

  it("derives nothing once locked, while keys already handed out keep their material", async () => {
    const keys = await open();
    const before = await keys.signing("anchor" as KeyName);
    keys.lock();
    expect(keys.locked).toBe(true);
    await expect(keys.signing("anchor" as KeyName)).rejects.toThrow(Locked);
    await expect(keys.didKeys(DID_ID)).rejects.toThrow(Locked);
    expect(before.privateJwk().d).toHaveLength(43);
  });
});

describe("mintDid", () => {
  it("mints the same did:peer:4 from the seed, the entity ID and the route every time", async () => {
    const keys = await open();
    const minted = await mintDid(keys, DID_ID, MEDIATED);
    expect(minted).toEqual(await mintDid(await open(), DID_ID, MEDIATED));
    expect(minted.did).toBe(EXPECTED.mediatedShort);
    expect(isLongForm(minted.longFormDid)).toBe(true);
    expect(longToShort(minted.longFormDid)).toBe(minted.did);
    expect(decodeLongForm(minted.longFormDid)).toEqual(minted.inputDocument);
  });

  it("encodes the route as the DIDComm service: a mediator's routing DID, or the direct endpoint", async () => {
    const keys = await open();
    const mediated = await mintDid(keys, DID_ID, MEDIATED);
    const direct = await mintDid(keys, DID_ID, DIRECT);
    expect(mediated.inputDocument["service"]).toEqual([{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: MEDIATED.routingDid, accept: ["didcomm/v2"] } }]);
    expect(direct.inputDocument["service"]).toEqual([{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: DIRECT.endpoint, accept: ["didcomm/v2"] } }]);
    expect(direct.did).toBe(EXPECTED.directShort);
    expect(direct.did).not.toBe(mediated.did);
    expect((await mintDid(keys, DID_ID2, MEDIATED)).did).not.toBe(mediated.did);
  });

  it("lists exactly the entity's two keys as its authentication and key-agreement methods", async () => {
    const keys = await open();
    const { authentication, keyAgreement } = await keys.didKeys(DID_ID);
    const minted = await mintDid(keys, DID_ID, MEDIATED);
    expect(minted.inputDocument["verificationMethod"]).toEqual([
      { id: AUTHENTICATION_METHOD, type: "Multikey", publicKeyMultibase: authentication.publicKey },
      { id: KEY_AGREEMENT_METHOD, type: "Multikey", publicKeyMultibase: keyAgreement.publicKey },
    ]);
    expect(minted.inputDocument["authentication"]).toEqual([AUTHENTICATION_METHOD]);
    expect(minted.inputDocument["keyAgreement"]).toEqual([KEY_AGREEMENT_METHOD]);
  });

  it("resolves, as a peer would retain it, to the keys the seed derived", async () => {
    const keys = await open();
    const { authentication, keyAgreement } = await keys.didKeys(DID_ID);
    const minted = await mintDid(keys, DID_ID, MEDIATED);
    const resolved = peerResolution(minted.longFormDid);
    expect(resolved.did).toBe(minted.did);
    const [authenticationId] = authorizedMethodIds(resolved.document, "authentication");
    const [keyAgreementId] = authorizedMethodIds(resolved.document, "keyAgreement");
    expect(authenticationId).toBe(`${minted.longFormDid}${AUTHENTICATION_METHOD}`);
    expect(keyAgreementId).toBe(`${minted.longFormDid}${KEY_AGREEMENT_METHOD}`);
    expect(methodPublicKey(resolved.document, authenticationId as never)).toBe(authentication.publicKey);
    expect(methodPublicKey(resolved.document, keyAgreementId as never)).toBe(keyAgreement.publicKey);
  });

  it("mints a mediation arrangement's DID without a service", async () => {
    const keys = await open();
    const minted = await mintMediationDid(keys, MEDIATION);
    expect(minted.did).toBe(EXPECTED.mediationShort);
    expect(minted.inputDocument["service"]).toBeUndefined();
    expect(minted).toEqual(await mintMediationDid(keys, MEDIATION));
  });
});

describe("checkDidCreated", () => {
  /** The entity's record of a document: the spellings a `did.created` carries. */
  const recorded = (didId: DidId, inputDocument: JsonObject) => {
    const longFormDid = encodeLongForm(inputDocument) as Did;
    return { didId, did: longToShort(longFormDid) as Did, longFormDid };
  };

  it("accepts the entity the seed and route derive and refuses any other spelling, ID or route", async () => {
    const keys = await open();
    const minted = await mintDid(keys, DID_ID, MEDIATED);
    const { inputDocument: _document, ...created } = minted;
    await expect(checkDidCreated(keys, created, MEDIATED)).resolves.toBeUndefined();
    await expect(checkDidCreated(keys, created, DIRECT)).rejects.toThrow(IdentityMismatch);
    await expect(checkDidCreated(keys, { ...created, didId: DID_ID2 }, MEDIATED)).rejects.toThrow(IdentityMismatch);
    await expect(checkDidCreated(keys, { ...created, did: EXPECTED.directShort as Did }, MEDIATED)).rejects.toThrow(IdentityMismatch);
    await expect(checkDidCreated(keys, { ...created, longFormDid: created.did }, MEDIATED)).rejects.toThrow(InvalidDidDocument);
    await expect(checkDidCreated(await open(OTHER_SEED), created, MEDIATED)).rejects.toThrow(IdentityMismatch);
  });

  it("reads the recorded document rather than rebuilding it: another serialization of the same keys and route is the same entity", async () => {
    const keys = await open();
    const { inputDocument } = await mintDid(keys, DID_ID, DIRECT);
    const { authentication, keyAgreement } = await keys.didKeys(DID_ID);
    const reordered = Object.fromEntries(Object.entries(inputDocument).reverse());
    expect(encodeLongForm(reordered)).not.toBe(encodeLongForm(inputDocument));
    await expect(checkDidCreated(keys, recorded(DID_ID, reordered), DIRECT)).resolves.toBeUndefined();
    const asJwk = {
      ...inputDocument,
      verificationMethod: [
        { id: "#auth", type: "JsonWebKey2020", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: authentication.privateJwk().x } },
        { id: "#agree", type: "JsonWebKey2020", publicKeyJwk: { kty: "OKP", crv: "X25519", x: keyAgreement.privateJwk().x } },
      ],
      authentication: ["#auth"],
      keyAgreement: ["#agree"],
      service: [{ id: "#didcomm", type: ["DIDCommMessaging"], serviceEndpoint: [DIRECT.endpoint] }],
    };
    await expect(checkDidCreated(keys, recorded(DID_ID, asJwk), DIRECT)).resolves.toBeUndefined();
  });

  it("refuses a recorded document that authorizes any key but the entity's two, or sends anywhere but its bound route", async () => {
    const keys = await open();
    const { inputDocument } = await mintDid(keys, DID_ID, DIRECT);
    const other = (await keys.didKeys(DID_ID2)).authentication.publicKey;
    const cases: [string, JsonObject][] = [
      ["a foreign authentication reference", { ...inputDocument, authentication: [AUTHENTICATION_METHOD, "did:web:other.example#k"] }],
      ["an extra authentication key", { ...inputDocument, authentication: [AUTHENTICATION_METHOD, { id: "#more", type: "Multikey", publicKeyMultibase: other }] }],
      ["another entity's key as authentication", { ...inputDocument, verificationMethod: [{ id: "#key-1", type: "Multikey", publicKeyMultibase: other }, (inputDocument["verificationMethod"] as JsonObject[])[1] as JsonObject] }],
      ["the two keys swapped", { ...inputDocument, authentication: [KEY_AGREEMENT_METHOD], keyAgreement: [AUTHENTICATION_METHOD] }],
      ["no key-agreement method", { ...inputDocument, keyAgreement: [] }],
      ["no service", { ...inputDocument, service: [] }],
      ["a second DIDComm service", { ...inputDocument, service: [...(inputDocument["service"] as JsonObject[]), { id: "#other", type: "DIDCommMessaging", serviceEndpoint: "https://other.example/didcomm" }] }],
      ["a service to another endpoint", { ...inputDocument, service: [{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: "https://other.example/didcomm" } }] }],
    ];
    for (const [what, document] of cases) {
      await expect(checkDidCreated(keys, recorded(DID_ID, document), DIRECT), what).rejects.toThrow(IdentityMismatch);
    }
  });

  it("checks a mediation arrangement's DID the same way", async () => {
    const keys = await open();
    const minted = await mintMediationDid(keys, MEDIATION);
    const me = { keyName: mediationKeyName(MEDIATION), did: minted.longFormDid };
    await expect(checkMediationCreated(keys, { mediationId: MEDIATION, me })).resolves.toBeUndefined();
    const reordered = Object.fromEntries(Object.entries(minted.inputDocument).reverse());
    await expect(checkMediationCreated(keys, { mediationId: MEDIATION, me: { ...me, did: encodeLongForm(reordered) as Did } })).resolves.toBeUndefined();
    await expect(checkMediationCreated(keys, { mediationId: MEDIATION, me: { ...me, did: minted.did } })).rejects.toThrow(InvalidDidDocument);
    await expect(checkMediationCreated(await open(OTHER_SEED), { mediationId: MEDIATION, me })).rejects.toThrow(IdentityMismatch);
    const other = (await keys.didKeys(DID_ID)).authentication.publicKey;
    const foreign = { ...minted.inputDocument, authentication: [AUTHENTICATION_METHOD, { id: "#more", type: "Multikey", publicKeyMultibase: other }] };
    await expect(checkMediationCreated(keys, { mediationId: MEDIATION, me: { ...me, did: encodeLongForm(foreign) as Did } })).rejects.toThrow(IdentityMismatch);
  });
});
