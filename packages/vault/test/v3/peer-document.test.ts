import { canonicalize, type JsonObject } from "@estoc/event-store/v3";
import { encodeLongForm, encodeShortForm } from "@estoc/did-peer";
import { ed25519, edwardsToMontgomeryPub } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { base58, base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vitest";

import {
  InvalidDidDocument,
  authorizedMethodIds,
  canonicalDidOf,
  canonicalPublicKey,
  didcommServiceUris,
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

/** A long form over exact document bytes, hash and all: what only a hand-built encoder can put on the wire. */
function longFormOfBytes(json: Uint8Array, codec: number[] = [0x80, 0x04]): string {
  const encoded = "z" + base58.encode(Uint8Array.from([...codec, ...json]));
  const hash = "z" + base58.encode(Uint8Array.from([0x12, 0x20, ...sha256(new TextEncoder().encode(encoded))]));
  return `did:peer:4${hash}:${encoded}`;
}
const utf8 = (text: string) => new TextEncoder().encode(text);

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

  it("reads the input document from its raw bytes as strict JSON: invalid UTF-8, a duplicated member and another multicodec are refused although the hash matches", () => {
    const text = JSON.stringify(INPUT);
    expect(peerResolution(longFormOfBytes(utf8(text))).document).toEqual(peerResolution(LONG).document);
    const invalidUtf8 = Uint8Array.from([...utf8(text.slice(0, -1)), ...utf8(',"extra":"'), 0xff, ...utf8('"}')]);
    expect(() => peerResolution(longFormOfBytes(invalidUtf8))).toThrow(/strict JSON: not valid UTF-8/);
    expect(() => canonicalDidOf(longFormOfBytes(invalidUtf8))).toThrow(InvalidDidDocument);
    const duplicated = utf8(`${text.slice(0, -1)},"extra":1,"extra":2}`);
    expect(() => peerResolution(longFormOfBytes(duplicated))).toThrow(/duplicate member "extra"/);
    expect(() => canonicalDidOf(longFormOfBytes(duplicated))).toThrow(InvalidDidDocument);
    expect(() => peerResolution(longFormOfBytes(utf8(text), [0x80, 0x03]))).toThrow(/multicodec-tagged JSON/);
    expect(() => peerResolution(longFormOfBytes(utf8("[]")))).toThrow(/JSON object/);
    expect(() => peerResolution(longFormOfBytes(utf8('{"authentication": BROKEN_JSON}')))).toThrow(/encoded document is not JSON/);
    expect(() => canonicalDidOf(longFormOfBytes(utf8('{"authentication": BROKEN_JSON}')))).toThrow(InvalidDidDocument);
  });

  it("refuses an input document the method forbids or one whose members are not the shape a document gives them", () => {
    const refused = (document: JsonObject, message: RegExp) => {
      expect(() => peerResolution(encodeLongForm(document))).toThrow(message);
      expect(() => canonicalDidOf(encodeLongForm(document))).toThrow(InvalidDidDocument);
    };
    refused({ ...INPUT, id: "did:web:unrelated.example" }, /must not have a root `id`/);
    refused({ ...INPUT, verificationMethod: [{ id: "did:web:unrelated.example#key-1", type: "Multikey", publicKeyMultibase: ED_KEY }] }, /must be a relative reference/);
    refused({ ...INPUT, authentication: [{ id: "did:web:unrelated.example#e", type: "Multikey", publicKeyMultibase: ED_KEY }] }, /must be a relative reference/);
    refused({ ...INPUT, verificationMethod: 1 }, /verificationMethod is an array/);
    refused({ ...INPUT, verificationMethod: [{ type: "Multikey", publicKeyMultibase: ED_KEY }] }, /verificationMethod\[0\] has a string id/);
    refused({ ...INPUT, authentication: [1] }, /authentication\[0\] is an object/);
    refused({ ...INPUT, service: ["#service"] }, /service\[0\] is an object/);
    refused({ ...INPUT, alsoKnownAs: [1] }, /alsoKnownAs\[0\] is a string/);
    refused({ ...INPUT, authentication: ["#nope"] }, /references no verification method/);
    refused({ ...INPUT, keyAgreement: ["key-2"] }, /DID URL or a fragment reference/);
  });

  it("refuses a method missing its type, key material or a DID controller, a service with a malformed, duplicated or typeless ID, and a dangling reference in any relationship", () => {
    const refused = (document: JsonObject, message: RegExp) => {
      expect(() => peerResolution(encodeLongForm(document))).toThrow(message);
      expect(() => canonicalDidOf(encodeLongForm(document))).toThrow(InvalidDidDocument);
    };
    const patched = (base: JsonObject, patch: Record<string, unknown>): JsonObject => Object.fromEntries(Object.entries({ ...base, ...patch }).filter(([, value]) => value !== undefined)) as JsonObject;
    const method = (patch: Record<string, unknown>): JsonObject => ({ ...INPUT, verificationMethod: [patched({ id: "#key-1", type: "Multikey", publicKeyMultibase: ED_KEY }, patch), { id: "#key-2", type: "Multikey", publicKeyMultibase: X_KEY }] });
    refused(method({ type: 7 }), /verificationMethod\[0\] has a string type/);
    refused(method({ type: undefined }), /verificationMethod\[0\] has a string type/);
    refused(method({ controller: 7 }), /verificationMethod\[0\] has a DID controller if any/);
    refused(method({ controller: "bob.example" }), /verificationMethod\[0\] has a DID controller if any/);
    refused(method({ publicKeyMultibase: undefined }), /verificationMethod\[0\] carries one of publicKeyMultibase and publicKeyJwk/);
    refused(method({ publicKeyJwk: { kty: "OKP" } }), /verificationMethod\[0\] carries one of publicKeyMultibase and publicKeyJwk/);
    refused(method({ publicKeyMultibase: 7 }), /verificationMethod\[0\] has a string publicKeyMultibase/);
    refused(method({ publicKeyMultibase: undefined, publicKeyJwk: "x" }), /verificationMethod\[0\] has an object publicKeyJwk/);
    refused({ ...INPUT, authentication: [{ id: "#embedded", publicKeyMultibase: ED_KEY2 }] }, /authentication\[0\] has a string type/);
    const service = (patch: Record<string, unknown>): JsonObject => ({ ...INPUT, service: [patched({ id: "#service", type: "DIDCommMessaging", serviceEndpoint: "https://a.example" }, patch)] });
    refused(service({ id: "#bad id" }), /service\[0\]\.id is a DID URL or a fragment reference/);
    refused(service({ id: "#bad%escape" }), /service\[0\]\.id is a DID URL or a fragment reference/);
    refused(service({ id: "service" }), /service\[0\]\.id is a DID URL or a fragment reference/);
    refused(service({ type: undefined }), /service\[0\] has a type, a string or strings/);
    refused(service({ type: [] }), /service\[0\] has a type, a string or strings/);
    refused({ ...INPUT, service: [...(INPUT["service"] as JsonObject[]), { id: "#service", type: "LinkedDomains", serviceEndpoint: "https://bob.example" }] }, /two services are/);
    for (const relationship of ["assertionMethod", "capabilityInvocation", "capabilityDelegation"]) refused({ ...INPUT, [relationship]: ["#absent"] }, /references no verification method/);
    refused(service({ id: "did:web:bob.example#svc" }), /Service id must be a relative reference/);
  });
});

describe("peerResolution on key material and service endpoints", () => {
  const refused = (document: JsonObject, message: RegExp) => {
    expect(() => peerResolution(encodeLongForm(document))).toThrow(message);
    expect(() => canonicalDidOf(encodeLongForm(document))).toThrow(InvalidDidDocument);
  };
  const jwk = { kty: "OKP", crv: "Ed25519", x: base64urlnopad.encode(ED_PUBLIC) };
  const withJwk = (patch: JsonObject): JsonObject => ({ ...INPUT, verificationMethod: [{ id: "#key-1", type: "JsonWebKey2020", publicKeyJwk: { ...jwk, ...patch } }, ...(INPUT["verificationMethod"] as JsonObject[]).slice(1)] });

  it("refuses a publicKeyJwk carrying any private or symmetric member, listed or embedded, and keeps one with public members and metadata", () => {
    refused(withJwk({ d: base64urlnopad.encode(new Uint8Array(32).fill(1)) }), /verificationMethod\[0\] has a publicKeyJwk without the private member d/);
    for (const member of ["p", "q", "dp", "dq", "qi", "oth", "k"]) refused(withJwk({ [member]: "x" }), new RegExp(`without the private member ${member}`));
    refused({ ...INPUT, authentication: [{ id: "#e", type: "JsonWebKey2020", publicKeyJwk: { ...jwk, d: "x" } }] }, /authentication\[0\] has a publicKeyJwk without the private member d/);
    const resolved = peerResolution(encodeLongForm(withJwk({ kid: "k1", alg: "EdDSA", use: "sig", key_ops: ["verify"] })));
    expect(methodPublicKey(resolved.document, `${resolved.presentedDid}#key-1` as DidUrl)).toBe(ED_KEY);
  });

  const service = (endpoint: unknown): JsonObject => {
    const other: Record<string, unknown> = { id: "#other", type: "LinkedDomains" };
    if (endpoint !== undefined) other["serviceEndpoint"] = endpoint;
    return { ...INPUT, service: [...(INPUT["service"] as JsonObject[]), other as JsonObject] };
  };

  it("requires every service, DIDComm or not, to carry an endpoint: a URI, an object, or a non-empty array of either", () => {
    refused(service(undefined), /service\[1\] has a serviceEndpoint that is a URI or an object/);
    refused(service(7), /service\[1\] has a serviceEndpoint that is a URI or an object/);
    refused(service(null), /service\[1\] has a serviceEndpoint that is a URI or an object/);
    refused(service([]), /service\[1\] has a serviceEndpoint that is not empty/);
    refused(service(["https://a.example", 7]), /service\[1\] has a serviceEndpoint that is a URI or an object/);
    refused(service("not a URI"), /service\[1\] has a serviceEndpoint that is a URI/);
    for (const endpoint of ["https://a.example", { origins: ["https://a.example"] }, ["https://a.example", { uri: "wss://b.example" }]]) {
      const resolved = peerResolution(encodeLongForm(service(endpoint)));
      expect((resolved.document["service"] as JsonObject[])[1]?.["serviceEndpoint"]).toEqual(endpoint);
    }
  });

  it("holds a string endpoint to RFC 3986 URI syntax", () => {
    for (const uri of ["did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc", "https://a.example:8443/p/q?x=1&y#frag", "wss://[::1]:9/x", "http://user:pw@10.0.0.1/", "mailto:bob@example.com", "urn:uuid:019b2a54-05bd-74ef-b8ac-e8375cb776c2", "file:///tmp/x", "https://a.example/%E4%B8%AD", "a:"]) {
      expect(() => peerResolution(encodeLongForm(service(uri))), uri).not.toThrow();
    }
    for (const bad of ["not a URI", "https://a.example/a b", "https://a.example/%zz", "//no-scheme.example", "1http://a.example", "https://a.example/#a#b", "https://a.exam ple/", "https:// a.example/", "https://a.example/\n", ""]) {
      expect(() => peerResolution(encodeLongForm(service(bad))), JSON.stringify(bad)).toThrow(/serviceEndpoint that is a URI/);
    }
  });

  it("holds a bracketed host to the IPv6 and IPvFuture grammars: groups, one ::, a strict dotted-decimal tail, no zone", () => {
    for (const host of ["[::1]", "[1:2:3:4:5:6:7:8]", "[::ffff:192.0.2.128]", "[1::2:3.4.5.6]", "[2001:db8::]", "[v1.example]", "[V1.example]", "[vF.a:b~c]"]) {
      expect(() => peerResolution(encodeLongForm(service(`https://${host}/`))), host).not.toThrow();
    }
    for (const host of ["[1]", "[:::]", "[1::2::3]", "[12345::]", "[00000::1]", "[1:2:3:4:5:6:7:8:9]", "[::ffff:999.0.0.1]", "[::ffff:192.168.001.1]", "[::ffff:1.2.3]", "[fe80::1%25eth0]", "[fe80::1%eth0]", "[]", "[v.example]", "[v1example]", "[a.example]"]) {
      expect(() => peerResolution(encodeLongForm(service(`https://${host}/`))), host).toThrow(/serviceEndpoint that is a URI/);
    }
  });
});

describe("didcommServiceUris", () => {
  it("lists the endpoint URIs of the DIDComm services, as strings, objects or arrays of either, and skips other services", () => {
    const document: JsonObject = {
      id: "did:web:bob.example",
      service: [
        { id: "#a", type: "DIDCommMessaging", serviceEndpoint: "https://a.example" },
        { id: "#b", type: ["DIDCommMessaging"], serviceEndpoint: { uri: "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc", accept: ["didcomm/v2"] } },
        { id: "#c", type: "DIDCommMessaging", serviceEndpoint: ["https://c1.example", { uri: "https://c2.example" }] },
        { id: "#d", type: "LinkedDomains", serviceEndpoint: "https://d.example" },
      ],
    };
    expect(didcommServiceUris(document)).toEqual(["https://a.example", "did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc", "https://c1.example", "https://c2.example"]);
    expect(didcommServiceUris({ id: "did:web:bob.example" })).toEqual([]);
    expect(didcommServiceUris(peerResolution(LONG).document)).toEqual(["did:peer:2.Ez6LSbysY2xFMRpGMhb7tFTLMpeuPRaqaWM1yECx2AtzE3KCc"]);
  });

  it("refuses a DIDComm service whose endpoint carries no URI", () => {
    expect(() => didcommServiceUris({ service: [{ id: "#a", type: "DIDCommMessaging", serviceEndpoint: { accept: ["didcomm/v2"] } }] })).toThrow(/serviceEndpoint is a URI/);
    expect(() => didcommServiceUris({ service: [{ id: "#a", type: "DIDCommMessaging", serviceEndpoint: [1] }] })).toThrow(/serviceEndpoint\[0\] is a URI/);
    expect(() => didcommServiceUris({ service: "https://a.example" })).toThrow(/service is an array/);
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

describe("the canonical DID of a retained peer resolution", () => {
  it("is the short form, whichever spelling was presented", () => {
    const presentedLong = peerResolution(LONG);
    expect(canonicalDidOf(presentedLong.presentedDid)).toBe(presentedLong.did);
    expect(canonicalDidOf(SHORT as Did)).toBe(presentedLong.did);
  });
});
