import { canonicalize, type JsonObject } from "@estoc/event-store/v3";
import { encodeLongForm, encodeShortForm } from "@estoc/did-peer";
import { ed25519, edwardsToMontgomeryPub } from "@noble/curves/ed25519";
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  InvalidDidDocument,
  authorizedMethodIds,
  canonicalDidOf,
  canonicalPublicKey,
  methodPublicKey,
  peerResolution,
  rawCidOfBytes,
  splitDidUrl,
  type Did,
  type DidUrl,
} from "../../src/v3/index.js";

const ED_PUBLIC = ed25519.getPublicKey(new Uint8Array(32).fill(1));
const ED_PUBLIC2 = ed25519.getPublicKey(new Uint8Array(32).fill(2));
const X_PUBLIC = edwardsToMontgomeryPub(ED_PUBLIC);
const ED_KEY = canonicalPublicKey({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(ED_PUBLIC) });
const ED_KEY2 = canonicalPublicKey({ kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(ED_PUBLIC2) });
const X_KEY = canonicalPublicKey({ kty: "OKP", crv: "X25519", x: base64urlnopad.encode(X_PUBLIC) });

/** An input document exercising every rule of the retained representation: contexts, aliases, an explicit external controller, an embedded method, a relative service reference. */
const INPUT: JsonObject = {
  "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
  alsoKnownAs: ["did:example:alias"],
  verificationMethod: [
    { id: "#key-1", type: "Multikey", publicKeyMultibase: ED_KEY },
    { id: "#key-2", type: "Multikey", publicKeyMultibase: X_KEY },
    { id: "#delegate", type: "JsonWebKey2020", controller: "did:example:other", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(ED_PUBLIC2) } },
  ],
  authentication: ["#key-1", { id: "#embedded", type: "Multikey", publicKeyMultibase: ED_KEY2 }],
  keyAgreement: ["#key-2"],
  capabilityDelegation: ["#delegate"],
  service: [{ id: "#service", type: "DIDCommMessaging", serviceEndpoint: { uri: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc", accept: ["didcomm/v2"] } }],
};
const LONG = encodeLongForm(INPUT);
const SHORT = encodeShortForm(INPUT);

describe("peerResolution", () => {
  it("retains the long form's resolution: id is the long form, the short form joins alsoKnownAs, omitted controllers are filled, nothing else changes", () => {
    const resolved = peerResolution(LONG);
    expect(resolved.did).toBe(SHORT);
    expect(resolved.presentedDid).toBe(LONG);
    expect(resolved.document).toEqual({
      ...INPUT,
      id: LONG,
      alsoKnownAs: ["did:example:alias", SHORT],
      verificationMethod: [
        { id: "#key-1", type: "Multikey", publicKeyMultibase: ED_KEY, controller: LONG },
        { id: "#key-2", type: "Multikey", publicKeyMultibase: X_KEY, controller: LONG },
        { id: "#delegate", type: "JsonWebKey2020", controller: "did:example:other", publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(ED_PUBLIC2) } },
      ],
      authentication: ["#key-1", { id: "#embedded", type: "Multikey", publicKeyMultibase: ED_KEY2, controller: LONG }],
    });
    expect(Object.keys(resolved.document).sort()).toEqual([...Object.keys(INPUT), "id"].sort());
  });

  it("serializes the document as RFC 8785 JSON under its raw CID, the same bytes on every resolution", () => {
    const first = peerResolution(LONG);
    const again = peerResolution(LONG);
    expect(first.bytes).toEqual(canonicalize(first.document));
    expect(first.cid).toBe(rawCidOfBytes(first.bytes));
    expect(again.cid).toBe(first.cid);
    expect(again.bytes).toEqual(first.bytes);
  });

  it("starts alsoKnownAs from empty when the input has none and refuses one that is not an array", () => {
    const { alsoKnownAs: _aliases, ...bare } = INPUT;
    const resolved = peerResolution(encodeLongForm(bare));
    expect(resolved.document["alsoKnownAs"]).toEqual([resolved.did]);
    expect(() => peerResolution(encodeLongForm({ ...INPUT, alsoKnownAs: "did:example:alias" }))).toThrow(InvalidDidDocument);
  });

  it("refuses a short form, a spelling that is not numalgo 4, and a long form whose hash does not match its document", () => {
    expect(() => peerResolution(SHORT)).toThrow(InvalidDidDocument);
    expect(() => peerResolution("did:web:bob.example")).toThrow(InvalidDidDocument);
    const [hash] = LONG.slice("did:peer:4".length).split(":");
    const other = encodeLongForm({ ...INPUT, extra: true }).split(":")[3];
    expect(() => peerResolution(`did:peer:4${hash}:${other}`)).toThrow(/Hash is invalid/);
  });
});

describe("canonicalDidOf", () => {
  it("takes a validated long form to its short form, a short form as it is, and any other DID byte for byte", () => {
    expect(canonicalDidOf(LONG)).toBe(SHORT);
    expect(canonicalDidOf(SHORT)).toBe(SHORT);
    expect(canonicalDidOf("did:web:Bob.Example")).toBe("did:web:Bob.Example");
    expect(canonicalDidOf("did:web:bob.example.")).toBe("did:web:bob.example.");
    expect(canonicalDidOf("did:web:bob.example")).not.toBe(canonicalDidOf("did:web:Bob.Example"));
  });

  it("refuses what is not a DID or not a valid numalgo-4 spelling", () => {
    expect(() => canonicalDidOf("bob.example")).toThrow(InvalidDidDocument);
    expect(() => canonicalDidOf("did:peer:4zQmNotAHash:z2Doc")).toThrow(InvalidDidDocument);
    expect(() => canonicalDidOf(`${LONG}extra`)).toThrow(InvalidDidDocument);
  });
});

describe("splitDidUrl", () => {
  it("splits at the first path, query or fragment delimiter", () => {
    expect(splitDidUrl("did:web:bob.example#key-1")).toEqual(["did:web:bob.example", "#key-1"]);
    expect(splitDidUrl("did:web:bob.example?versionId=1#key-1")).toEqual(["did:web:bob.example", "?versionId=1#key-1"]);
    expect(splitDidUrl("did:web:bob.example/path#key-1")).toEqual(["did:web:bob.example", "/path#key-1"]);
    expect(splitDidUrl("did:web:bob.example")).toEqual(["did:web:bob.example", ""]);
  });
});

describe("authorizedMethodIds", () => {
  const document = peerResolution(LONG).document;

  it("lists references resolved against the document id and embedded methods by their own ids, in order", () => {
    expect(authorizedMethodIds(document, "authentication")).toEqual([`${LONG}#key-1`, `${LONG}#embedded`]);
    expect(authorizedMethodIds(document, "keyAgreement")).toEqual([`${LONG}#key-2`]);
  });

  it("keeps an absolute reference, into this document or another, and lists a repeated method once", () => {
    const web: JsonObject = {
      id: "did:web:bob.example",
      verificationMethod: [{ id: "did:web:bob.example#a", type: "Multikey", controller: "did:web:bob.example", publicKeyMultibase: ED_KEY }],
      authentication: ["#a", "did:web:bob.example#a", "did:web:other.example#k"],
    };
    expect(authorizedMethodIds(web, "authentication")).toEqual(["did:web:bob.example#a", "did:web:other.example#k"]);
    expect(authorizedMethodIds(web, "keyAgreement")).toEqual([]);
  });

  it("refuses a reference into this document that names no method, a path-relative reference, and an entry of another shape", () => {
    const base = { id: "did:web:bob.example", verificationMethod: [{ id: "#a", type: "Multikey", publicKeyMultibase: ED_KEY }] };
    expect(() => authorizedMethodIds({ ...base, authentication: ["#b"] }, "authentication")).toThrow(/references no verification method/);
    expect(() => authorizedMethodIds({ ...base, authentication: ["a"] }, "authentication")).toThrow(InvalidDidDocument);
    expect(() => authorizedMethodIds({ ...base, authentication: [1] }, "authentication")).toThrow(InvalidDidDocument);
    expect(() => authorizedMethodIds({ ...base, authentication: "#a" }, "authentication")).toThrow(InvalidDidDocument);
    expect(() => authorizedMethodIds({ verificationMethod: [] }, "authentication")).toThrow(/document id/);
  });

  it("refuses two different methods under one id", () => {
    const twice: JsonObject = {
      id: "did:web:bob.example",
      verificationMethod: [
        { id: "#a", type: "Multikey", publicKeyMultibase: ED_KEY },
        { id: "did:web:bob.example#a", type: "Multikey", publicKeyMultibase: ED_KEY2 },
      ],
      authentication: ["#a"],
    };
    expect(() => authorizedMethodIds(twice, "authentication")).toThrow(/two different verification methods/);
  });
});

describe("methodPublicKey", () => {
  const document = peerResolution(LONG).document;

  it("reads a method's key from publicKeyMultibase or publicKeyJwk, canonical either way, from a listed or an embedded method", () => {
    expect(methodPublicKey(document, `${LONG}#key-1` as DidUrl)).toBe(ED_KEY);
    expect(methodPublicKey(document, `${LONG}#key-2` as DidUrl)).toBe(X_KEY);
    expect(methodPublicKey(document, `${LONG}#delegate` as DidUrl)).toBe(ED_KEY2);
    expect(methodPublicKey(document, `${LONG}#embedded` as DidUrl)).toBe(ED_KEY2);
  });

  it("refuses an unknown method, a method with no key or two keys, and a key that is not one", () => {
    expect(() => methodPublicKey(document, `${LONG}#key-9` as DidUrl)).toThrow(/defines no verification method/);
    const withMethod = (method: JsonObject): JsonObject => ({ id: "did:web:bob.example", verificationMethod: [{ id: "#a", type: "Multikey", ...method }] });
    expect(() => methodPublicKey(withMethod({}), "did:web:bob.example#a" as DidUrl)).toThrow(/one of publicKeyMultibase and publicKeyJwk/);
    expect(() => methodPublicKey(withMethod({ publicKeyMultibase: ED_KEY, publicKeyJwk: { kty: "OKP" } }), "did:web:bob.example#a" as DidUrl)).toThrow(InvalidDidDocument);
    expect(() => methodPublicKey(withMethod({ publicKeyMultibase: "z6MkNotAKey" }), "did:web:bob.example#a" as DidUrl)).toThrow(InvalidDidDocument);
  });
});

describe("the retained peer DID as a birth address", () => {
  it("is the short form, whichever spelling was presented", () => {
    const presentedLong = peerResolution(LONG);
    expect(canonicalDidOf(presentedLong.presentedDid)).toBe(presentedLong.did);
    expect(canonicalDidOf(SHORT as Did)).toBe(presentedLong.did);
  });
});
