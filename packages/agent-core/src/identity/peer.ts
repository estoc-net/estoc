import bs58 from "bs58";

import { encodeLongForm } from "@estoc/did-peer";
import type { Secret } from "@estoc/did-peer";
import type { DerivedIdentity } from "@estoc/keystore";
import { base64urlToBytes } from "@estoc/did-peer";

/**
 * A DIDComm-ready did:peer:4 from a seed-derived identity: Multikey long
 * form with one Ed25519 authentication key and one X25519 key agreement
 * key — the document shape the mediator's demo-interop test pins. Given
 * the same identity and service, the DID comes out identical, so a vault
 * can check its recorded DIDs against its seed on open.
 *
 * Two flavours make up a mediated identity: no service at all (the DID the
 * mediator knows — its mail is picked up, never pushed), and a service
 * naming the mediator's routing DID (the public DID a correspondent writes
 * to, DIDComm v2 routing's blessed shape). Pairwise DIDs are the second
 * flavour, minted once per relationship.
 */

export interface PeerIdentity {
  did: string;
  /** the two private JWKs under this DID's key ids — what didcomm-rust's SecretsResolver hands out */
  secrets: Secret[];
}

/** multicodec prefixes for raw public keys */
export const ED25519_PUB = [0xed, 0x01];
export const X25519_PUB = [0xec, 0x01];

/** The multibase a document lists (`z…`, base58btc) of a multicodec-prefixed raw public key: what a `did:key` encodes. */
export function multibaseKey(prefix: number[], publicKey: Uint8Array): string {
  const bytes = new Uint8Array(prefix.length + publicKey.length);
  bytes.set(prefix);
  bytes.set(publicKey, prefix.length);
  return `z${bs58.encode(bytes)}`;
}

export function mintPeerDid(
  identity: DerivedIdentity,
  serviceUri: string | null
): PeerIdentity {
  const jwks = identity.privateJwks();
  const edPub = base64urlToBytes(jwks.ed25519.x as string);
  const xPub = base64urlToBytes(jwks.x25519.x as string);

  const did = encodeLongForm({
    "@context": [
      "https://www.w3.org/ns/did/v1",
      "https://w3id.org/security/multikey/v1",
    ],
    verificationMethod: [
      {
        id: "#key-1",
        type: "Multikey",
        publicKeyMultibase: multibaseKey(ED25519_PUB, edPub),
      },
      {
        id: "#key-2",
        type: "Multikey",
        publicKeyMultibase: multibaseKey(X25519_PUB, xPub),
      },
    ],
    authentication: ["#key-1"],
    capabilityDelegation: ["#key-1"],
    keyAgreement: ["#key-2"],
    ...(serviceUri === null
      ? {}
      : {
          service: [
            {
              type: "DIDCommMessaging",
              id: "#service",
              serviceEndpoint: {
                uri: serviceUri,
                accept: ["didcomm/v2"],
              },
            },
          ],
        }),
  });

  return {
    did,
    secrets: [
      {
        id: `${did}#key-1`,
        type: "JsonWebKey2020",
        privateKeyJwk: { ...jwks.ed25519 },
      },
      {
        id: `${did}#key-2`,
        type: "JsonWebKey2020",
        privateKeyJwk: { ...jwks.x25519 },
      },
    ],
  };
}
