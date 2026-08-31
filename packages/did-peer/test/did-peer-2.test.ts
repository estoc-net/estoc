import { describe, it, expect } from "vitest";
import { isPeerDID2, resolve } from "../src/did-peer-2.js";
import { toDIDCommDIDDoc } from "../src/did-doc.js";
import {
  MEDIATOR_DID,
  MEDIATOR_ENDPOINT,
  PEER_2_DID,
  PEER_2_DOCUMENT,
} from "./fixtures/peer-did-2.js";

describe("did:peer:2 resolution", () => {
  it("matches the reference implementation's test vector", () => {
    expect(resolve(PEER_2_DID)).toStrictEqual(PEER_2_DOCUMENT);
  });

  it("recognizes the method", () => {
    expect(isPeerDID2(PEER_2_DID)).toBe(true);
    expect(isPeerDID2("did:peer:4zQmd6RdU6e2nDrLn1rjwdA5Buzq7wJwsv3WJ1AgrwKYJoLE")).toBe(false);
    expect(isPeerDID2("did:web:example.com")).toBe(false);
  });

  it("numbers keys across purposes in the order they appear", () => {
    const did =
      "did:peer:2" +
      ".Ez6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR" +
      ".Vz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc" +
      ".Az6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc";
    const document = resolve(did);

    expect(document.keyAgreement).toStrictEqual(["#key-1"]);
    expect(document.authentication).toStrictEqual(["#key-2"]);
    expect(document.assertionMethod).toStrictEqual(["#key-3"]);
  });

  it("leaves out relationships and services the DID does not carry", () => {
    const document = resolve(
      "did:peer:2.Vz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc"
    );

    expect(document.authentication).toStrictEqual(["#key-1"]);
    expect(document.keyAgreement).toBeUndefined();
    expect(document.service).toBeUndefined();
  });

  it("keeps an id a service block gives itself", () => {
    // { "t": "dm", "s": { "uri": "http://example.com" }, "id": "#mine" }
    const service = Buffer.from(
      JSON.stringify({ t: "dm", s: { uri: "http://example.com" }, id: "#mine" })
    ).toString("base64url");
    const document = resolve(`did:peer:2.S${service}`);

    expect(document.service).toStrictEqual([
      { id: "#mine", type: "DIDCommMessaging", serviceEndpoint: { uri: "http://example.com" } },
    ]);
  });

  it("refuses a DID it cannot make sense of", () => {
    expect(() => resolve("did:web:example.com")).toThrow(/Not a did:peer:2/);
    expect(() => resolve("did:peer:2")).toThrow(/at least one element/);
    expect(() => resolve("did:peer:2.V")).toThrow(/carries no value/);
    expect(() => resolve("did:peer:2.Xz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc")).toThrow(
      /Unknown purpose code "X"/
    );
    expect(() => resolve("did:peer:2.Vq6Mkj3PUd1WjvaDhNZ")).toThrow(/base58btc multibase/);
    expect(() => resolve("did:peer:2.Vz6Mkj3PUd0OIl")).toThrow(/valid base58btc/);
    expect(() => resolve("did:peer:2.Snot-encoded-json")).toThrow(/base64url-encoded JSON/);
  });
});

describe("a mediator's did:peer:2", () => {
  it("resolves to the endpoint and key a forward is addressed with", () => {
    const didDoc = toDIDCommDIDDoc(resolve(MEDIATOR_DID));

    // Multikey remapped by multicodec prefix, since didcomm-rust has no such
    // type and a forward is anoncrypted to the key agreement key.
    expect(didDoc.verificationMethod).toContainEqual({
      id: `${MEDIATOR_DID}#key-2`,
      controller: MEDIATOR_DID,
      type: "X25519KeyAgreementKey2020",
      publicKeyMultibase: "z6LSn9Sk4ZxZpWLsrPvjxPEmpuBTyhd41zWFgWXiwhi6Tufj",
    });
    expect(didDoc.keyAgreement).toStrictEqual([`${MEDIATOR_DID}#key-2`]);

    // The websocket service survives the conversion; the two did-communication
    // ones do not, being neither DIDCommMessaging nor v2.
    expect(didDoc.service.map((service) => (typeof service.serviceEndpoint === "string" ? service.serviceEndpoint : service.serviceEndpoint.uri))).toStrictEqual([
      MEDIATOR_ENDPOINT,
      "wss://ws.us-east2.public.mediator.indiciotech.io/ws",
    ]);
  });
});
