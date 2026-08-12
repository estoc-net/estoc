/**
 * Test vector from the reference implementation at
 * decentralized-identity/did-peer-2 (`tests/test_did_peer_2.py`).
 *
 * Two keys and two services, which is enough to pin every rule that can be got
 * wrong: keys numbered across purposes, the first service named `#service` and
 * the second `#service-1`, and the abbreviations expanded inside the endpoint
 * object as well as at the top of the block.
 */
export const PEER_2_DID =
  "did:peer:2.Vz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc.Ez6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly9leGFtcGxlLmNvbS9kaWRjb21tIiwiYSI6WyJkaWRjb21tL3YyIl0sInIiOlsiZGlkOmV4YW1wbGU6MTIzNDU2Nzg5YWJjZGVmZ2hpI2tleS0xIl19fQ.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly9leGFtcGxlLmNvbS9hbm90aGVyIiwiYSI6WyJkaWRjb21tL3YyIl0sInIiOlsiZGlkOmV4YW1wbGU6MTIzNDU2Nzg5YWJjZGVmZ2hpI2tleS0yIl19fQ";

/**
 * The document the reference implementation resolves that DID to, less its
 * `alsoKnownAs`: that alias is the did:peer:3 form, a numalgo of its own that
 * nothing here reads.
 */
export const PEER_2_DOCUMENT = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/multikey/v1",
  ],
  id: PEER_2_DID,
  verificationMethod: [
    {
      id: "#key-1",
      controller: PEER_2_DID,
      type: "Multikey",
      publicKeyMultibase: "z6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc",
    },
    {
      id: "#key-2",
      controller: PEER_2_DID,
      type: "Multikey",
      publicKeyMultibase: "z6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR",
    },
  ],
  authentication: ["#key-1"],
  keyAgreement: ["#key-2"],
  service: [
    {
      id: "#service",
      type: "DIDCommMessaging",
      serviceEndpoint: {
        uri: "http://example.com/didcomm",
        accept: ["didcomm/v2"],
        routingKeys: ["did:example:123456789abcdefghi#key-1"],
      },
    },
    {
      id: "#service-1",
      type: "DIDCommMessaging",
      serviceEndpoint: {
        uri: "http://example.com/another",
        accept: ["didcomm/v2"],
        routingKeys: ["did:example:123456789abcdefghi#key-2"],
      },
    },
  ],
};

/**
 * A mediator in the wild — Indicio's public one, named as the service endpoint
 * by every agent the DIF DIDComm demo creates. It carries four services: the
 * DIDComm v2 pair this cares about, and a did-communication pair from v1 whose
 * endpoint is a bare string.
 */
export const MEDIATOR_DID =
  "did:peer:2.Vz6Mkgs6MwYB3YgToZXGwknqC352cbHtxJsi3zXZfF1t2fNkT.Ez6LSn9Sk4ZxZpWLsrPvjxPEmpuBTyhd41zWFgWXiwhi6Tufj.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHBzOi8vdXMtZWFzdDIucHVibGljLm1lZGlhdG9yLmluZGljaW90ZWNoLmlvL21lc3NhZ2UiLCJhIjpbImRpZGNvbW0vdjIiLCJkaWRjb21tL2FpcDI7ZW52PXJmYzE5Il19fQ.SeyJ0IjoiZG0iLCJzIjp7InVyaSI6IndzczovL3dzLnVzLWVhc3QyLnB1YmxpYy5tZWRpYXRvci5pbmRpY2lvdGVjaC5pby93cyIsImEiOlsiZGlkY29tbS92MiIsImRpZGNvbW0vYWlwMjtlbnY9cmZjMTkiXX19.SeyJ0IjoiZGlkLWNvbW11bmljYXRpb24iLCJzIjoiaHR0cHM6Ly91cy1lYXN0Mi5wdWJsaWMubWVkaWF0b3IuaW5kaWNpb3RlY2guaW8vbWVzc2FnZSIsImEiOlsiZGlkY29tbS92MiIsImRpZGNvbW0vYWlwMjtlbnY9cmZjMTkiXSwicmVjaXBpZW50S2V5cyI6WyIja2V5LTEiXX0.SeyJ0IjoiZGlkLWNvbW11bmljYXRpb24iLCJzIjoid3NzOi8vd3MudXMtZWFzdDIucHVibGljLm1lZGlhdG9yLmluZGljaW90ZWNoLmlvL3dzIiwiYSI6WyJkaWRjb21tL3YyIiwiZGlkY29tbS9haXAyO2Vudj1yZmMxOSJdLCJyZWNpcGllbnRLZXlzIjpbIiNrZXktMSJdfQ";

export const MEDIATOR_ENDPOINT =
  "https://us-east2.public.mediator.indiciotech.io/message";
