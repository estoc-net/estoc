import { describe, it, expect } from "vitest";
import { toDIDCommDIDDoc } from "../src/did-doc.js";
import {
  encodeLongForm,
  resolveLongForm,
} from "../src/did-peer-4.js";
import { PEER_4_INPUT_DOCUMENT } from "./fixtures/peer-did-4.js";

const LONG_DID = encodeLongForm(PEER_4_INPUT_DOCUMENT);

describe("toDIDCommDIDDoc", () => {
  it("converts a resolved did:peer:4 document", () => {
    const didDoc = toDIDCommDIDDoc(resolveLongForm(LONG_DID));

    expect(didDoc.id).toBe(LONG_DID);
    expect(didDoc.authentication).toStrictEqual([`${LONG_DID}#6MkrCD1c`]);
    expect(didDoc.keyAgreement).toStrictEqual([`${LONG_DID}#6LSqPZfn`]);
    expect(didDoc.verificationMethod).toHaveLength(2);
    expect(didDoc.service).toStrictEqual([
      {
        id: `${LONG_DID}#didcommmessaging-0`,
        type: "DIDCommMessaging",
        serviceEndpoint: {
          uri: "didcomm:transport/queue",
          routingKeys: [],
          accept: ["didcomm/v2"],
        },
      },
    ]);
  });

  it("hoists embedded verification methods out of relationships", () => {
    const didDoc = toDIDCommDIDDoc({
      id: "did:example:alice",
      authentication: [
        {
          id: "#key-1",
          type: "Ed25519VerificationKey2020",
          publicKeyMultibase: "z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr",
        },
      ],
    });

    expect(didDoc.authentication).toStrictEqual(["did:example:alice#key-1"]);
    expect(didDoc.verificationMethod).toStrictEqual([
      {
        id: "did:example:alice#key-1",
        type: "Ed25519VerificationKey2020",
        controller: "did:example:alice",
        publicKeyMultibase: "z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr",
      },
    ]);
  });

  it("remaps Multikey to the suite didcomm-rust understands", () => {
    const didDoc = toDIDCommDIDDoc({
      id: "did:example:alice",
      verificationMethod: [
        {
          id: "#key-1",
          type: "Multikey",
          publicKeyMultibase: "z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr",
        },
        {
          id: "#key-2",
          type: "Multikey",
          publicKeyMultibase: "z6LSqPZfn9krvgXma2icTMKf2uVcYhKXsudCmPoUzqGYW24U",
        },
      ],
    });

    expect(didDoc.verificationMethod.map((method) => method.type)).toStrictEqual([
      "Ed25519VerificationKey2020",
      "X25519KeyAgreementKey2020",
    ]);
  });

  it("maps unrecognized verification method types to Other", () => {
    // didcomm-rust fails to deserialize the whole DIDDoc on an unknown type,
    // so an unusable method must not poison the rest of the document.
    const didDoc = toDIDCommDIDDoc({
      id: "did:example:alice",
      verificationMethod: [
        { id: "#key-1", type: "UnsupportedVerificationMethod2026" },
        { id: "#key-2", type: "Multikey", publicKeyMultibase: "zNotAKnownPrefix" },
      ],
    });

    expect(didDoc.verificationMethod.map((method) => method.type)).toStrictEqual([
      "Other",
      "Other",
    ]);
  });

  it("absolutizes relative routing keys", () => {
    const didDoc = toDIDCommDIDDoc({
      id: "did:example:alice",
      service: [
        {
          id: "#didcomm-0",
          type: "DIDCommMessaging",
          serviceEndpoint: {
            uri: "https://example.com/endpoint",
            routingKeys: ["#key-2", "did:example:mediator#key-1"],
          },
        },
      ],
    });

    expect(didDoc.service[0]?.serviceEndpoint).toStrictEqual({
      uri: "https://example.com/endpoint",
      routingKeys: ["did:example:alice#key-2", "did:example:mediator#key-1"],
    });
  });

  it("normalizes a string serviceEndpoint and drops other service types", () => {
    const didDoc = toDIDCommDIDDoc({
      id: "did:example:alice",
      service: [
        {
          id: "#didcomm-0",
          type: "DIDCommMessaging",
          serviceEndpoint: "https://example.com/endpoint",
        },
        {
          id: "#hub",
          type: "LinkedDomains",
          serviceEndpoint: "https://example.com",
        },
      ],
    });

    expect(didDoc.service).toStrictEqual([
      {
        id: "did:example:alice#didcomm-0",
        type: "DIDCommMessaging",
        serviceEndpoint: { uri: "https://example.com/endpoint", routingKeys: [] },
      },
    ]);
  });

  it("rejects a document without an id", () => {
    expect(() => toDIDCommDIDDoc({ authentication: [] })).toThrow(
      /no string `id`/
    );
  });
});
