import { describe, it, expect } from "vitest";
import {
  absolutizeReferences,
  decode,
  encodeLongForm,
  encodeShortForm,
  isLongForm,
  isShortForm,
  longToShort,
  resolveLongForm,
  resolveShortForm,
  resolveShortFormFromDocument,
  validateInputDocument,
} from "../src/did-peer-4.js";
import {
  PEER_4_INPUT_DOCUMENT,
  PEER_4_SHORT_DID,
} from "./fixtures/peer-did-4.js";

const LONG_DID = encodeLongForm(PEER_4_INPUT_DOCUMENT);

describe("did:peer:4 encoding", () => {
  it("matches the spec test vector", () => {
    expect(encodeShortForm(PEER_4_INPUT_DOCUMENT)).toBe(PEER_4_SHORT_DID);
    expect(longToShort(LONG_DID)).toBe(PEER_4_SHORT_DID);
  });

  it("recognizes long and short forms", () => {
    expect(isLongForm(LONG_DID)).toBe(true);
    expect(isShortForm(LONG_DID)).toBe(false);
    expect(isShortForm(PEER_4_SHORT_DID)).toBe(true);
    expect(isLongForm(PEER_4_SHORT_DID)).toBe(false);
  });

  it("round-trips the input document", () => {
    expect(decode(LONG_DID)).toStrictEqual(PEER_4_INPUT_DOCUMENT);
  });

  it("rejects a tampered document", () => {
    const [hash] = LONG_DID.slice("did:peer:4".length).split(":");
    const tampered = encodeLongForm({ ...PEER_4_INPUT_DOCUMENT, extra: true });
    const forged = `did:peer:4${hash}:${tampered.split(":")[3]}`;

    expect(() => decode(forged)).toThrow(/Hash is invalid/);
  });

  it("refuses to decode a short form", () => {
    expect(() => decode(PEER_4_SHORT_DID)).toThrow(/short form/);
  });
});

describe("did:peer:4 resolution", () => {
  it("resolves the long form with the short form as an alias", () => {
    const doc = resolveLongForm(LONG_DID);

    expect(doc.id).toBe(LONG_DID);
    expect(doc.alsoKnownAs).toStrictEqual([PEER_4_SHORT_DID]);
  });

  it("resolves the short form with the long form as an alias", () => {
    const doc = resolveShortForm(LONG_DID);

    expect(doc.id).toBe(PEER_4_SHORT_DID);
    expect(doc.alsoKnownAs).toStrictEqual([LONG_DID]);
  });

  it("defaults verification method controllers to the DID", () => {
    const doc = resolveLongForm(LONG_DID);
    const methods = doc.verificationMethod;

    expect(Array.isArray(methods)).toBe(true);
    for (const method of Array.isArray(methods) ? methods : []) {
      expect(method.controller).toBe(LONG_DID);
    }
  });

  it("keeps references relative, per the spec", () => {
    const doc = resolveLongForm(LONG_DID);

    expect(doc.authentication).toStrictEqual(["#6MkrCD1c"]);
  });

  it("verifies the document hashes to the expected short form DID", () => {
    const doc = resolveShortFormFromDocument(
      PEER_4_INPUT_DOCUMENT,
      PEER_4_SHORT_DID
    );

    expect(doc.id).toBe(PEER_4_SHORT_DID);
    expect(() =>
      resolveShortFormFromDocument(PEER_4_INPUT_DOCUMENT, "did:peer:4zQmWrong")
    ).toThrow(/DID mismatch/);
  });
});

describe("validateInputDocument", () => {
  it("accepts a conformant input document", () => {
    expect(() => validateInputDocument(PEER_4_INPUT_DOCUMENT)).not.toThrow();
  });

  it("rejects a root id", () => {
    expect(() =>
      validateInputDocument({ ...PEER_4_INPUT_DOCUMENT, id: "did:example:bogus" })
    ).toThrow(/must not have a root `id`/);
  });

  it("rejects an absolute verification method id", () => {
    expect(() =>
      validateInputDocument({
        verificationMethod: [
          { id: "did:example:bogus#key-1", type: "Ed25519VerificationKey2020" },
        ],
      })
    ).toThrow(/Verification method id must be a relative reference/);
  });

  it("rejects an absolute id on an embedded verification method", () => {
    expect(() =>
      validateInputDocument({
        authentication: [
          { id: "did:example:bogus#key-1", type: "Ed25519VerificationKey2020" },
        ],
      })
    ).toThrow(/Embedded authentication verification method id/);
  });

  it("rejects an absolute service id", () => {
    expect(() =>
      validateInputDocument({
        service: [{ id: "did:example:bogus#svc", type: "DIDCommMessaging" }],
      })
    ).toThrow(/Service id must be a relative reference/);
  });

  it("allows relationship references to another DID's key", () => {
    // A string entry is a reference, not a definition — pointing at a mediator
    // or another controller's key is legitimate.
    expect(() =>
      validateInputDocument({ authentication: ["did:example:mediator#key-1"] })
    ).not.toThrow();
  });

  it("allows relative DID URLs that are not plain fragments", () => {
    expect(() =>
      validateInputDocument({
        verificationMethod: [
          { id: "?version=1#key-1", type: "Ed25519VerificationKey2020" },
        ],
      })
    ).not.toThrow();
  });

  it("is not applied when resolving, so sloppy peers stay interoperable", () => {
    const nonConformant = { ...PEER_4_INPUT_DOCUMENT, id: "did:example:bogus" };
    const did = encodeLongForm(nonConformant);

    expect(resolveLongForm(did).id).toBe(did);
  });
});

describe("absolutizeReferences", () => {
  it("rewrites relative references against the document id", () => {
    const doc = absolutizeReferences(resolveLongForm(LONG_DID));

    expect(doc.authentication).toStrictEqual([`${LONG_DID}#6MkrCD1c`]);
    expect(doc.keyAgreement).toStrictEqual([`${LONG_DID}#6LSqPZfn`]);

    const methods = Array.isArray(doc.verificationMethod)
      ? doc.verificationMethod
      : [];
    expect(methods.map((method) => method.id)).toStrictEqual([
      `${LONG_DID}#6LSqPZfn`,
      `${LONG_DID}#6MkrCD1c`,
    ]);

    const services = Array.isArray(doc.service) ? doc.service : [];
    expect(services[0].id).toBe(`${LONG_DID}#didcommmessaging-0`);
  });

  it("absolutizes relative routing keys but leaves mediator keys alone", () => {
    const doc = absolutizeReferences({
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

    const services = Array.isArray(doc.service) ? doc.service : [];
    expect(services[0].serviceEndpoint.routingKeys).toStrictEqual([
      "did:example:alice#key-2",
      "did:example:mediator#key-1",
    ]);
  });

  it("resolves query-form relative DID URLs", () => {
    const doc = absolutizeReferences({
      id: "did:example:alice",
      authentication: ["?version=1#key-1"],
    });

    expect(doc.authentication).toStrictEqual([
      "did:example:alice?version=1#key-1",
    ]);
  });

  it("leaves path-style references alone rather than guessing", () => {
    // RFC 3986 would resolve these against a base with no authority in a way
    // that discards the method-specific id, so we do not rewrite them.
    const doc = absolutizeReferences({
      id: "did:example:alice",
      authentication: ["/key-1", "key-2"],
    });

    expect(doc.authentication).toStrictEqual(["/key-1", "key-2"]);
  });

  it("leaves absolute references untouched", () => {
    const doc = absolutizeReferences({
      id: "did:example:alice",
      authentication: ["did:example:alice#key-1"],
    });

    expect(doc.authentication).toStrictEqual(["did:example:alice#key-1"]);
  });
});
