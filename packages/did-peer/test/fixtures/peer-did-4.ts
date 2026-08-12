/**
 * Test vector from the did:peer:4 spec, matching the reference implementation in
 * references/did-peer-4-ts/lib/index.test.ts.
 */
export const PEER_4_INPUT_DOCUMENT = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/x25519-2020/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1",
  ],
  verificationMethod: [
    {
      id: "#6LSqPZfn",
      type: "X25519KeyAgreementKey2020",
      publicKeyMultibase: "z6LSqPZfn9krvgXma2icTMKf2uVcYhKXsudCmPoUzqGYW24U",
    },
    {
      id: "#6MkrCD1c",
      type: "Ed25519VerificationKey2020",
      publicKeyMultibase: "z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr",
    },
  ],
  authentication: ["#6MkrCD1c"],
  assertionMethod: ["#6MkrCD1c"],
  keyAgreement: ["#6LSqPZfn"],
  capabilityInvocation: ["#6MkrCD1c"],
  capabilityDelegation: ["#6MkrCD1c"],
  service: [
    {
      id: "#didcommmessaging-0",
      type: "DIDCommMessaging",
      serviceEndpoint: {
        uri: "didcomm:transport/queue",
        accept: ["didcomm/v2"],
        routingKeys: [],
      },
    },
  ],
};

export const PEER_4_SHORT_DID =
  "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd";
