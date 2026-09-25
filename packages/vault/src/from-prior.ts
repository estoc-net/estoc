/**
 * The host's side of the DIDComm `from_prior` proof, whose parsing,
 * profile, verification, binding and creation are
 * `@estoc/continuity/from-prior`'s: signing a local rotation with the
 * key the seed derives for the predecessor entity, under the method its
 * own document gives that key; and finding the issuer material a
 * carried proof verifies against, which is the issuer's long form —
 * the spelling itself when the proof presents one, or the one a
 * retained resolution of a short-form issuer holds.
 */

import { InvalidFromPrior, createFromPrior } from "@estoc/continuity/from-prior";
import { isLongForm } from "@estoc/did-peer";

import { InvalidDidDocument } from "./errors.js";
import { resolvedDocumentOf, type ReadObject } from "./fold/evidence.js";
import type { Keys } from "./identity.js";
import { didKeyName } from "./ids.js";
import { authorizedMethodIds, methodPublicKey, peerResolution, splitDidUrl } from "./peer-document.js";
import type { Did, DidId, VaultData } from "./types.js";

/**
 * Sign that the successor continues the predecessor: `iss` is the
 * predecessor's long form, `sub` the successor's, `kid` the method of
 * the predecessor's own document that carries the entity's
 * authentication key, whatever fragment that document gave it, and the
 * signature that key's. The token comes back verified against the
 * predecessor's document.
 */
export async function signFromPrior(keys: Keys, predecessor: { didId: DidId; longFormDid: Did }, successorLongFormDid: Did, iat: number): Promise<string> {
  if (!isLongForm(predecessor.longFormDid) || !isLongForm(successorLongFormDid)) throw new InvalidFromPrior("iss and sub are did:peer:4 long forms", "profile");
  const key = await keys.signing(didKeyName(predecessor.didId, "authentication"));
  let methodId: string | undefined;
  try {
    const { document } = peerResolution(predecessor.longFormDid);
    methodId = authorizedMethodIds(document, "authentication").find((id) => splitDidUrl(id)[0] === predecessor.longFormDid && methodPublicKey(document, id) === key.publicKey);
  } catch (err) {
    if (err instanceof InvalidDidDocument) throw new InvalidFromPrior(err.message, "document");
    throw err;
  }
  if (methodId === undefined) throw new InvalidFromPrior(`${predecessor.longFormDid} authorizes no authentication method carrying the entity's key`, "document");
  const proof = await createFromPrior(
    { issuer: predecessor.longFormDid, change: { kind: "rotate", successor: successorLongFormDid }, iat, evidence: { ref: predecessor.longFormDid, longForm: predecessor.longFormDid } },
    { methodId, sign: (input) => key.sign(input) }
  );
  return proof.token;
}

/** The long form a proof's issuer verifies against, and what it was taken from: the spelling itself, or the retained resolution that holds it. */
export type IssuerLongForm = { ref: string; longForm: Did };

/**
 * The immutable document of a proof's issuer, as the long form that
 * encodes it. A long-form issuer is its own. A short-form issuer needs
 * a retained resolution of that DID: the first of those given whose
 * document reads, presented under the long form or read back from the
 * object store, since a numalgo-4 document read back is exactly what
 * its own long form derives. Null while none is here: a long form seen
 * only in other event data is not material.
 */
export async function issuerLongFormOf(iss: Did, retained: Iterable<{ ref: string; data: VaultData["peer.resolved"] }>, readObject: ReadObject): Promise<IssuerLongForm | null> {
  if (isLongForm(iss)) return { ref: iss, longForm: iss };
  for (const { ref, data } of retained) {
    if (data.did !== iss) continue;
    if (isLongForm(data.presentedDid)) return { ref, longForm: data.presentedDid };
    let document;
    try {
      document = await resolvedDocumentOf(data, readObject);
    } catch (err) {
      if (err instanceof InvalidDidDocument) continue;
      throw err;
    }
    const id = document?.["id"];
    if (typeof id === "string" && isLongForm(id)) return { ref, longForm: id as Did };
  }
  return null;
}
