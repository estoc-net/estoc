import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { bytesToBase64url, resolveDIDCommDoc, type DIDDoc, type VerificationMethod } from "@estoc/did-peer";
import { createSeedKeystore, deriveIdentity } from "@estoc/keystore";
import { peerKeyOf, sameChannel } from "@estoc/vault/v2";

import {
  envelopeKind,
  inboundPair,
  mintPeerDid,
  outboundPair,
  peerKeyOfMethod,
  publicKeyOf,
  publicKeyOfMethod,
  resolvedOf,
  senderOf,
  signerOf,
  type Unpacked,
} from "../../src/v2/index.js";

const SEED = new Uint8Array(32).map((_, i) => i);
const ROUTING = "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE9VVs";
const WEB = "did:web:example.com";

/** two did:peer:4 identities and their documents: alice with no service, bob behind a routing DID */
async function scene() {
  const { seedKey } = await createSeedKeystore("test", { seed: SEED });
  const alice = mintPeerDid(await deriveIdentity(seedKey, "did/alice"), null);
  const bob = mintPeerDid(await deriveIdentity(seedKey, "did/bob"), ROUTING);
  const aliceDoc = (await resolveDIDCommDoc(alice.did)) as DIDDoc;
  const bobDoc = (await resolveDIDCommDoc(bob.did)) as DIDDoc;
  const keyOfDid = (did: string): string | null => (did === alice.did ? "did/alice" : null);
  return { alice, bob, aliceDoc, bobDoc, keyOfDid };
}

/** the document's key `n` as multibase */
function key(doc: DIDDoc, n: 1 | 2): string {
  const method = doc.verificationMethod.find((entry) => entry.id === `${doc.id}#key-${n}`) as VerificationMethod;
  return method.publicKeyMultibase as string;
}

const kid = (doc: DIDDoc, n: 1 | 2): string => `${doc.id}#key-${n}`;

function authcrypt(from: string, to: string, signedBy?: string): Unpacked {
  return {
    encrypted: true,
    non_repudiation: signedBy !== undefined,
    encrypted_from_kid: from,
    encrypted_to_kids: [to],
    ...(signedBy === undefined ? {} : { sign_from: signedBy }),
  };
}

function anoncrypt(to: string, signedBy?: string): Unpacked {
  return { encrypted: true, non_repudiation: signedBy !== undefined, encrypted_to_kids: [to], ...(signedBy === undefined ? {} : { sign_from: signedBy }) };
}

const signed = (by: string): Unpacked => ({ encrypted: false, non_repudiation: true, sign_from: by });
const PLAIN: Unpacked = { encrypted: false, non_repudiation: false };

/** the raw key behind a multibase, as a did:web document would list it: an OKP JWK */
function jwkMethod(id: string, crv: "Ed25519" | "X25519", multibase: string): VerificationMethod {
  const raw = bs58.decode(multibase.slice(1)).slice(2);
  return { id, type: "JsonWebKey2020", controller: id.split("#")[0] as string, publicKeyJwk: { kty: "OKP", crv, x: bytesToBase64url(raw) } };
}

describe("envelopeKind and senderOf", () => {
  it("reads the kind off what unpack proved, whose DID proved it, and whose signed inside", async () => {
    const { alice, bob, aliceDoc, bobDoc } = await scene();
    const cases: [Unpacked, ReturnType<typeof envelopeKind>, string | null, string | null][] = [
      [authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2)), "authcrypt", bob.did, null],
      [authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2), kid(bobDoc, 1)), "authcrypt", bob.did, bob.did],
      [authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2), `${WEB}#ed`), "authcrypt", bob.did, WEB],
      [anoncrypt(kid(aliceDoc, 2)), "anoncrypt", null, null],
      [anoncrypt(kid(aliceDoc, 2), kid(bobDoc, 1)), "signed", bob.did, null],
      [signed(kid(bobDoc, 1)), "signed", bob.did, null],
      [PLAIN, null, null, null],
    ];
    for (const [metadata, kind, sender, signer] of cases) {
      expect(envelopeKind(metadata)).toBe(kind);
      expect(senderOf(metadata)).toBe(sender);
      expect(signerOf(metadata)).toBe(signer);
    }
    expect(alice.did).not.toBe(bob.did);
  });
});

describe("inboundPair", () => {
  it("authcrypt: our key that opened it, the fingerprint of the key that sealed it", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const proved = inboundPair(authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2)), bobDoc, keyOfDid);
    expect(proved).toEqual({
      pair: { myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 2)) },
      kind: "authcrypt",
      peerPublicKey: key(bobDoc, 2),
    });
  });

  it("authcrypt with a signature inside: the same channel, the signer noted as the document lists it", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const proved = inboundPair(authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2), kid(bobDoc, 1)), bobDoc, keyOfDid);
    expect(proved?.kind).toBe("authcrypt");
    expect(proved?.pair).toEqual({ myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 2)) });
    expect(proved?.signedBy).toBe(key(bobDoc, 1));
  });

  it("a signature by a key of another DID is named from that DID's document, and is an error without it", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const metadata = authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2), `${WEB}#ed`);
    const web: DIDDoc = { id: WEB, authentication: [`${WEB}#ed`], keyAgreement: [], verificationMethod: [jwkMethod(`${WEB}#ed`, "Ed25519", key(aliceDoc, 1))], service: [] };
    const proved = inboundPair(metadata, bobDoc, keyOfDid, web);
    expect(proved?.pair).toEqual({ myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 2)) });
    expect(proved?.signedBy).toBe(key(aliceDoc, 1));
    expect(() => inboundPair(metadata, bobDoc, keyOfDid)).toThrow(/no document/);
    expect(() => inboundPair(metadata, bobDoc, keyOfDid, { ...web, verificationMethod: [] })).toThrow(/lists no/);
  });

  it("anoncrypt: our key, no peer key, nothing of theirs to hand back", async () => {
    const { aliceDoc, keyOfDid } = await scene();
    expect(inboundPair(anoncrypt(kid(aliceDoc, 2)), null, keyOfDid)).toEqual({ pair: { myKey: "did/alice", peerKey: null }, kind: "anoncrypt" });
  });

  it("signed: the signing key places it, inside anoncrypt with our key and bare with none", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const inside = inboundPair(anoncrypt(kid(aliceDoc, 2), kid(bobDoc, 1)), bobDoc, keyOfDid);
    expect(inside).toEqual({ pair: { myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 1)) }, kind: "signed", peerPublicKey: key(bobDoc, 1) });
    const bare = inboundPair(signed(kid(bobDoc, 1)), bobDoc, keyOfDid);
    expect(bare).toEqual({ pair: { myKey: null, peerKey: peerKeyOf(key(bobDoc, 1)) }, kind: "signed", peerPublicKey: key(bobDoc, 1) });
  });

  it("a plaintext opens no channel", async () => {
    const { keyOfDid } = await scene();
    expect(inboundPair(PLAIN, null, keyOfDid)).toBeNull();
  });

  it("opened with the first of the kids that is ours; sealed to none of ours is an error", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const two: Unpacked = { ...anoncrypt(kid(aliceDoc, 2)), encrypted_to_kids: [kid(bobDoc, 2), kid(aliceDoc, 2)] };
    expect(inboundPair(two, null, keyOfDid)?.pair.myKey).toBe("did/alice");
    expect(() => inboundPair(anoncrypt(kid(bobDoc, 2)), null, keyOfDid)).toThrow(/no key of ours/);
  });

  it("a sealing or signing key the sender's document does not list is an error", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    expect(() => inboundPair(authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2)), null, keyOfDid)).toThrow(/no document/);
    expect(() => inboundPair(authcrypt(`${bobDoc.id}#key-9`, kid(aliceDoc, 2)), bobDoc, keyOfDid)).toThrow(/lists no/);
    expect(() => inboundPair(signed(`${bobDoc.id}#key-9`), bobDoc, keyOfDid)).toThrow(/lists no/);
  });
});

describe("outboundPair", () => {
  it("seals to the first key agreement key, authcrypt from our key, anoncrypt from none", async () => {
    const { bobDoc } = await scene();
    const proved = outboundPair("did/alice", bobDoc);
    expect(proved).toEqual({ pair: { myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 2)) }, kind: "authcrypt", peerPublicKey: key(bobDoc, 2) });
    expect(outboundPair(null, bobDoc)).toEqual({ pair: { myKey: null, peerKey: peerKeyOf(key(bobDoc, 2)) }, kind: "anoncrypt", peerPublicKey: key(bobDoc, 2) });
    expect(() => outboundPair("did/alice", { ...bobDoc, keyAgreement: [] })).toThrow(/no key agreement/);
  });

  it("what we seal to bob and what bob seals to us is one channel", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const out = outboundPair("did/alice", bobDoc);
    const back = inboundPair(authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2)), bobDoc, keyOfDid) as { pair: typeof out.pair };
    expect(sameChannel(out.pair, back.pair)).toBe(true);
  });
});

describe("keys as a document lists them", () => {
  it("a JWK, a base58 key and a multibase of the same key have one name and one fingerprint", async () => {
    const { bobDoc } = await scene();
    const ed = key(bobDoc, 1);
    const x = key(bobDoc, 2);
    expect(publicKeyOf(jwkMethod(`${WEB}#ed`, "Ed25519", ed))).toBe(ed);
    expect(publicKeyOf(jwkMethod(`${WEB}#x`, "X25519", x))).toBe(x);
    const raw = bs58.decode(ed.slice(1)).slice(2);
    expect(publicKeyOf({ id: `${WEB}#b58`, type: "Ed25519VerificationKey2018", controller: WEB, publicKeyBase58: bs58.encode(raw) })).toBe(ed);
    expect(peerKeyOfMethod(jwkMethod(`${WEB}#x`, "X25519", x))).toBe(peerKeyOf(x));
  });

  it("another curve, a bent value or an unknown suite is a key this vault has no name for", () => {
    const p256: VerificationMethod = { id: `${WEB}#p`, type: "JsonWebKey2020", controller: WEB, publicKeyJwk: { kty: "EC", crv: "P-256", x: "AA", y: "AA" } };
    expect(publicKeyOf(p256)).toBeNull();
    expect(() => publicKeyOfMethod(p256)).toThrow(/can name/);
    expect(publicKeyOf({ id: `${WEB}#short`, type: "JsonWebKey2020", controller: WEB, publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } })).toBeNull();
    expect(publicKeyOf({ id: `${WEB}#bad`, type: "JsonWebKey2020", controller: WEB, publicKeyJwk: { kty: "OKP", crv: "X25519", x: "!!" } })).toBeNull();
    expect(publicKeyOf({ id: `${WEB}#other`, type: "Other", controller: WEB, publicKeyBase58: "abc" })).toBeNull();
    expect(publicKeyOf({ id: `${WEB}#none`, type: "Other", controller: WEB })).toBeNull();
  });

  it("a multibase is checked like the rest: base58btc, one of the two prefixes, 32 bytes", async () => {
    const { bobDoc } = await scene();
    const multibase = (value: string): VerificationMethod => ({ id: `${WEB}#m`, type: "Multikey", controller: WEB, publicKeyMultibase: value });
    const ed = key(bobDoc, 1);
    expect(publicKeyOf(multibase(ed))).toBe(ed);
    const bytes = bs58.decode(ed.slice(1));
    const p256 = new Uint8Array(35);
    p256.set([0x80, 0x24]);
    const cases = ["not-a-multibase", "z", "z0OIl", `m${ed.slice(1)}`, `z${bs58.encode(p256)}`, `z${bs58.encode(bytes.slice(0, 33))}`, `z${bs58.encode(bytes.slice(2))}`];
    for (const value of cases) {
      expect(publicKeyOf(multibase(value)), value).toBeNull();
    }
    const doc: DIDDoc = { id: WEB, authentication: [], keyAgreement: [], verificationMethod: cases.map(multibase).concat(multibase(ed)), service: [] };
    expect(resolvedOf({ myKey: null, peerKey: null }, WEB, doc).keys).toEqual([ed]);
  });

  it("a did:web listing bob's keys as JWKs is bob's channel: the DID is not in the pair", async () => {
    const { aliceDoc, bobDoc, keyOfDid } = await scene();
    const web: DIDDoc = {
      id: WEB,
      authentication: [`${WEB}#ed`],
      keyAgreement: [`${WEB}#x`],
      verificationMethod: [jwkMethod(`${WEB}#ed`, "Ed25519", key(bobDoc, 1)), jwkMethod(`${WEB}#x`, "X25519", key(bobDoc, 2))],
      service: [{ id: `${WEB}#dm`, type: "DIDCommMessaging", serviceEndpoint: "https://example.com/didcomm" }],
    };
    const asPeer = inboundPair(authcrypt(kid(bobDoc, 2), kid(aliceDoc, 2)), bobDoc, keyOfDid) as { pair: { myKey: string | null; peerKey: string | null } };
    const asWeb = inboundPair(authcrypt(`${WEB}#x`, kid(aliceDoc, 2)), web, keyOfDid) as { pair: { myKey: string | null; peerKey: string | null } };
    expect(sameChannel(asPeer.pair, asWeb.pair)).toBe(true);
    expect(senderOf(authcrypt(`${WEB}#x`, kid(aliceDoc, 2)))).toBe(WEB);
  });
});

describe("resolvedOf", () => {
  it("every key the document lists, in its order, and its first service", async () => {
    const { bob, bobDoc, aliceDoc, alice } = await scene();
    const pair = { myKey: "did/alice", peerKey: peerKeyOf(key(bobDoc, 2)) };
    expect(resolvedOf(pair, bob.did, bobDoc)).toEqual({ ...pair, did: bob.did, keys: [key(bobDoc, 1), key(bobDoc, 2)], service: ROUTING });
    expect(resolvedOf(pair, alice.did, aliceDoc).service).toBeNull();
  });

  it("a string endpoint is its uri; a key with no name is left out, never an error", async () => {
    const { bobDoc } = await scene();
    const pair = { myKey: null, peerKey: peerKeyOf(key(bobDoc, 1)) };
    const web: DIDDoc = {
      id: WEB,
      authentication: [`${WEB}#ed`],
      keyAgreement: [],
      verificationMethod: [
        jwkMethod(`${WEB}#ed`, "Ed25519", key(bobDoc, 1)),
        { id: `${WEB}#p`, type: "JsonWebKey2020", controller: WEB, publicKeyJwk: { kty: "EC", crv: "P-256", x: "AA", y: "AA" } },
      ],
      service: [{ id: `${WEB}#dm`, type: "DIDCommMessaging", serviceEndpoint: "https://example.com/didcomm" }],
    };
    expect(resolvedOf(pair, WEB, web)).toEqual({ myKey: null, peerKey: pair.peerKey, did: WEB, keys: [key(bobDoc, 1)], service: "https://example.com/didcomm" });
    // only the pair's two fields travel, whatever else rode on the object
    expect(resolvedOf({ ...pair, kind: "signed" } as typeof pair, WEB, web)).not.toHaveProperty("kind");
  });
});
