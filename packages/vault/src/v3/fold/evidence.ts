/**
 * The checks beside the fold that need the retained objects: whether
 * each `peer.resolved` snapshot is what its document says. A fold is a
 * pure function of the set and cannot read an object; these run once
 * over the objects and hand the fold their verdicts, one per event,
 * none while the object is not here.
 */

import { isLongForm } from "@estoc/did-peer";
import { canonicalize, isJsonObject, parseStrict, type JsonObject } from "@estoc/event-store/v3";

import { rawCidOfBytes } from "../document.js";
import { InvalidDidDocument, InvalidPublicKey } from "../errors.js";
import { authorizedMethodIds, canonicalDidOf, methodPublicKey, peerResolution } from "../peer-document.js";
import { agreementKey } from "../public-key.js";
import type { Cid, EventId, VaultData } from "../types.js";
import type { VaultEventSet } from "./set.js";

/** The verdict on one piece of evidence a fold cannot reach on its own; no entry while what it needs is not here. */
export type EvidenceCheck = "verified" | "invalid";

/** Reads the retained object a CID names: null while the object is not here. */
export type ReadObject = (cid: Cid) => Promise<Uint8Array | null>;

const PEER4_PREFIX = "did:peer:4";

/**
 * The document a resolution names, as the vault retains it, once the
 * presented spelling is one of the canonical DID's: for a numalgo-4
 * long form derived from the spelling itself, for anything else read
 * from the object store by CID and checked to be those bytes in
 * canonical form. A numalgo-4 document read back must be exactly what
 * its own long form derives, since that derivation is the only retained
 * representation and a document's `id` alone is any key's to claim.
 * Null while the object is not here; a throw when what is here is not
 * the document the resolution says.
 */
export async function resolvedDocumentOf(resolution: VaultData["peer.resolved"], readObject: ReadObject): Promise<JsonObject | null> {
  if (canonicalDidOf(resolution.presentedDid) !== resolution.did) throw new InvalidDidDocument(`${resolution.presentedDid} is not a spelling of ${resolution.did}`);
  if (isLongForm(resolution.presentedDid)) {
    const derived = peerResolution(resolution.presentedDid);
    if (derived.did !== resolution.did) throw new InvalidDidDocument(`the long form is ${derived.did}'s, not ${resolution.did}'s`);
    if (derived.cid !== resolution.documentCid) throw new InvalidDidDocument(`the long form derives ${derived.cid}, not the recorded ${resolution.documentCid}`);
    return derived.document;
  }
  const bytes = await readObject(resolution.documentCid);
  if (bytes === null) return null;
  if (rawCidOfBytes(bytes) !== resolution.documentCid) throw new InvalidDidDocument(`the object read is not ${resolution.documentCid}`);
  let document: unknown;
  try {
    document = parseStrict(bytes);
  } catch (err) {
    throw new InvalidDidDocument(`the retained document is not strict JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isJsonObject(document)) throw new InvalidDidDocument("the retained document is a JSON object");
  const id = document["id"];
  if (typeof id !== "string" || canonicalDidOf(id) !== resolution.did) throw new InvalidDidDocument(`the retained document is not ${resolution.did}'s`);
  if (!resolution.did.startsWith(PEER4_PREFIX)) {
    if (rawCidOfBytes(canonicalize(document)) !== resolution.documentCid) throw new InvalidDidDocument("the retained document is not in canonical form");
    return document;
  }
  if (!isLongForm(id)) throw new InvalidDidDocument("the retained document's id is not the long form");
  const derived = peerResolution(id);
  if (derived.cid !== resolution.documentCid) throw new InvalidDidDocument(`the retained document is not what ${id} derives`);
  return derived.document;
}

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Every `peer.resolved` event's snapshot checked against its own
 * document: the method IDs it enumerates are exactly the ones the
 * document authorizes, in document order, and the key it
 * authenticates is one the document authorizes for key agreement and
 * one that agrees keys. A receipt is decrypted and a package encrypted
 * to a key-agreement key alone; the authentication methods sign proofs
 * and never stand in for one. No verdict while the object is not here.
 */
export async function verifyResolutions(set: VaultEventSet, readObject: ReadObject): Promise<Map<EventId, EvidenceCheck>> {
  const checks = new Map<EventId, EvidenceCheck>();
  for (const event of set.of("peer.resolved")) {
    const { data } = event;
    try {
      const document = await resolvedDocumentOf(data, readObject);
      if (document === null) continue;
      const authentication = authorizedMethodIds(document, "authentication");
      const keyAgreement = authorizedMethodIds(document, "keyAgreement");
      if (!sameIds(authentication, data.authenticationMethodIds)) throw new InvalidDidDocument("the authentication methods are not the document's");
      if (!sameIds(keyAgreement, data.keyAgreementMethodIds)) throw new InvalidDidDocument("the key-agreement methods are not the document's");
      const keys = keyAgreement.flatMap((id) => {
        try {
          return [methodPublicKey(document, id)];
        } catch (err) {
          if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey) return [];
          throw err;
        }
      });
      if (!keys.includes(data.peerPublicKey)) throw new InvalidDidDocument(`${data.peerPublicKey} is not a key the document authorizes for key agreement`);
      agreementKey(data.peerPublicKey);
      checks.set(event.eventId, "verified");
    } catch (err) {
      if (!(err instanceof InvalidDidDocument || err instanceof InvalidPublicKey)) throw err;
      checks.set(event.eventId, "invalid");
    }
  }
  return checks;
}
