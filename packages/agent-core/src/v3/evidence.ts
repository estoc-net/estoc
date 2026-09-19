/**
 * Resolution evidence as the vault keeps it and as didcomm reads it:
 * `peer.resolved` with its document object, one record per resolution
 * for one authenticated or selected peer key; and the documents
 * didcomm opens and seals against, each under the spelling it asks
 * for. A fresh resolution and a pinned snapshot are kept apart: the
 * first is what a sender or recipient is read from now, the second is
 * what a `from_prior` issuer is verified against, whatever the peer
 * publishes today.
 */

import { DIDDocConversionError, isLongForm, toDIDCommDIDDoc, type DIDDoc } from "@estoc/did-peer";
import { DamagedObject, isJsonObject, parseStrict, type Held, type JsonObject, type VaultRuntime } from "@estoc/event-store/v3";
import {
  InvalidDidDocument,
  VaultEventSet,
  InvalidPublicKey,
  canonicalDidOf,
  methodPublicKey,
  peerResolution,
  rawCidOfBytes,
  readVaultEvent,
  samePayload,
  vaultDraft,
  type Cid,
  type Did,
  type DidUrl,
  type KeyName,
  type PublicKey,
  type ReadObject,
  type VaultData,
  type VaultEvent,
  type VaultFold,
} from "@estoc/vault/v3";

import type { DIDResolver } from "../protocol/didcomm.js";
import { UnauthorizedKey } from "./errors.js";
import { knownLongForms, type Resolution } from "./resolver.js";
import { sameDid } from "./same-did.js";

/** One resolution with the key it is evidence for: the local key that took part and the peer key authenticated or selected. */
export interface ResolutionEvidence {
  resolution: Resolution;
  localKeyName: KeyName;
  peerPublicKey: PublicKey;
}

/** The keys a resolved document authorizes for one use, by method ID: only methods the document itself defines with a key of a supported type. */
export function authorizedKeys(resolution: Resolution, relationship: "authentication" | "keyAgreement"): Map<DidUrl, PublicKey> {
  const keys = new Map<DidUrl, PublicKey>();
  for (const id of relationship === "authentication" ? resolution.authenticationMethodIds : resolution.keyAgreementMethodIds) {
    try {
      keys.set(id, methodPublicKey(resolution.document, id));
    } catch (err) {
      if (!(err instanceof InvalidDidDocument || err instanceof InvalidPublicKey)) throw err;
    }
  }
  return keys;
}

/** The `peer.resolved` payload the evidence records; `UnauthorizedKey` when the document authorizes no method carrying the peer key. */
export function resolutionData({ resolution, localKeyName, peerPublicKey }: ResolutionEvidence): VaultData["peer.resolved"] {
  const authorized = [...authorizedKeys(resolution, "authentication").values(), ...authorizedKeys(resolution, "keyAgreement").values()];
  if (!authorized.includes(peerPublicKey)) throw new UnauthorizedKey(resolution.did, peerPublicKey);
  return {
    localKeyName,
    peerPublicKey,
    presentedDid: resolution.presentedDid,
    did: resolution.did,
    documentCid: resolution.cid,
    authenticationMethodIds: [...resolution.authenticationMethodIds],
    keyAgreementMethodIds: [...resolution.keyAgreementMethodIds],
    service: resolution.service,
  };
}

export interface CommitResolutionOptions {
  /** record the resolution even when an equal one is there: the caller wants evidence of its own */
  fresh?: boolean;
}

/** Whether every object is accepted and not known damaged; one known damaged counts as absent, since the bytes coming in repair it. */
export async function objectsHeld(held: Held, cids: Iterable<Cid>): Promise<boolean> {
  for (const cid of cids) {
    try {
      if (!(await held.objects.has(cid))) return false;
    } catch (err) {
      if (err instanceof DamagedObject) return false;
      throw err;
    }
  }
  return true;
}

/**
 * `peer.resolved` for the evidence, with its document object, under
 * the writer lock — the runtime's, or one already held. An event already recording exactly this — same
 * spellings, document, methods, service and keys — is returned instead
 * of being repeated, unless `fresh` asks for a new one or the document
 * it names is not here: evidence that arrived without its object, or
 * whose object was found damaged, is what the bytes in hand repair,
 * and the new event carries them in while the old event's pin reads
 * again.
 */
export async function commitResolution(runtime: Pick<VaultRuntime, "locked">, evidence: ResolutionEvidence, options: CommitResolutionOptions = {}): Promise<VaultEvent<"peer.resolved">> {
  const data = resolutionData(evidence);
  return runtime.locked(async (held) => {
    if (!options.fresh) {
      const set = await VaultEventSet.from(held.events.scan());
      const recorded = set.of("peer.resolved").find((event) => samePayload(event.data, data));
      if (recorded !== undefined && (await objectsHeld(held, [evidence.resolution.cid]))) return recorded;
    }
    const [event] = (await held.commit([{ cid: evidence.resolution.cid, source: evidence.resolution.bytes }], [vaultDraft("peer.resolved", data)])).map(readVaultEvent);
    return event as VaultEvent<"peer.resolved">;
  });
}

/**
 * The resolution a recorded event stands for, read back: a numalgo-4
 * long form derives its document again, anything else is read from
 * the object store. Null while the object is not here; a throw when
 * what is here is not the document the event says.
 */
export async function readResolution(event: VaultEvent<"peer.resolved">, readObject: ReadObject): Promise<Resolution | null> {
  const { data } = event;
  const resolution = (document: Resolution["document"], bytes: Uint8Array): Resolution => ({
    presentedDid: data.presentedDid,
    did: data.did,
    document,
    bytes,
    cid: data.documentCid,
    authenticationMethodIds: [...data.authenticationMethodIds],
    keyAgreementMethodIds: [...data.keyAgreementMethodIds],
    service: data.service,
  });
  if (isLongForm(data.presentedDid)) {
    const derived = peerResolution(data.presentedDid);
    if (derived.cid !== data.documentCid) throw new InvalidDidDocument(`${data.presentedDid} derives ${derived.cid}, not the recorded ${data.documentCid}`);
    return resolution(derived.document, derived.bytes);
  }
  const bytes = await readObject(data.documentCid);
  if (bytes === null) return null;
  if (rawCidOfBytes(bytes) !== data.documentCid) throw new InvalidDidDocument(`the object read is not ${data.documentCid}`);
  const document = parseStrict(bytes);
  if (!isJsonObject(document)) throw new InvalidDidDocument("the retained document is a JSON object");
  const id = document["id"];
  if (typeof id !== "string" || canonicalDidOf(id) !== data.did) throw new InvalidDidDocument(`the retained document is not ${data.did}'s`);
  return resolution(document, bytes);
}

/**
 * The document as didcomm can hold it. didcomm reads a document's
 * methods as one, each with material of a kind it knows — a JWK, a
 * multibase or a base58 key — and refuses the whole document on one
 * of another kind; and it follows a relationship's references only to
 * the document's own methods, refusing any other. What the projection
 * leaves out stays in the resolution, the retained bytes and the
 * evidence; a key `authorizedKeys` offers is read from material of
 * such a kind and so is never one left out.
 */
function didcommProjection(document: JsonObject): DIDDoc {
  const converted = toDIDCommDIDDoc(document);
  const verificationMethod = converted.verificationMethod.filter((method) => method.publicKeyJwk !== undefined || method.publicKeyMultibase !== undefined || method.publicKeyBase58 !== undefined);
  const kept = new Set(verificationMethod.map((method) => method.id));
  const stays = (id: string) => kept.has(id);
  return { ...converted, verificationMethod, authentication: converted.authentication.filter(stays), keyAgreement: converted.keyAgreement.filter(stays) };
}

/**
 * The document as didcomm reads it, identified by `spelling`: the
 * resolved document itself when that is its `id`, and for a numalgo-4
 * document asked for under its other spelling the same document
 * under that `id`, so that the key IDs didcomm looks up are the ones
 * the envelope names. A spelling of another DID is refused.
 */
export function didcommDocumentOf(resolution: Resolution, spelling: string = resolution.presentedDid): DIDDoc {
  if (spelling === resolution.document["id"]) return didcommProjection(resolution.document);
  if (canonicalDidOf(spelling) !== resolution.did) throw new InvalidDidDocument(`${spelling} is not a spelling of ${resolution.did}`);
  return didcommProjection({ ...resolution.document, id: spelling });
}

export interface PinnedResolverOptions {
  /** the resolutions made fresh for the work in hand: what a sender or a recipient is read from */
  current?: Iterable<Resolution>;
  /** the snapshots pinned for the work in hand: what a `from_prior` issuer is verified against */
  pinned?: Iterable<Resolution>;
}

/**
 * didcomm's resolver for one piece of work. A DID it asks for is
 * answered, in this order, from the current resolutions, from the
 * pinned snapshots, from this vault's own entities and mediation
 * identities, and from a numalgo-4 spelling itself — its long form
 * directly, its short form through a long form the fold has in
 * evidence. Nothing here goes to the network: a document that has to
 * be fresh is resolved before, and handed in as current.
 */
export function pinnedResolver(fold: VaultFold, options: PinnedResolverOptions = {}): DIDResolver {
  const current = [...(options.current ?? [])];
  const pinned = [...(options.pinned ?? [])];
  const known = knownLongForms(fold);
  const among = (resolutions: readonly Resolution[], did: string): Resolution | undefined => resolutions.find((r) => r.presentedDid === did) ?? resolutions.find((r) => sameDid(r.did, did));
  const local = (did: string): DIDDoc | null => {
    for (const entity of fold.routes.dids.values()) {
      if (entity.created !== null && entity.resolution !== null && !entity.conflict && sameDid(entity.created.did, did)) return didcommProjection({ ...entity.resolution.document, id: did });
    }
    for (const mediation of fold.mediations.mediations.values()) {
      if (mediation.me !== null && mediation.status !== "conflict" && sameDid(mediation.me.did, did)) return didcommProjection({ ...peerResolution(mediation.me.did).document, id: did });
    }
    return null;
  };
  const spelled = (did: string): DIDDoc | null => {
    const longForm = isLongForm(did) ? did : known(did as Did);
    return longForm === null ? null : didcommProjection({ ...peerResolution(longForm).document, id: did });
  };
  return {
    resolve: async (did: string): Promise<DIDDoc | null> => {
      try {
        const found = among(current, did) ?? among(pinned, did);
        if (found !== undefined) return didcommDocumentOf(found, did);
        return local(did) ?? spelled(did);
      } catch (err) {
        if (err instanceof InvalidDidDocument || err instanceof InvalidPublicKey || err instanceof DIDDocConversionError) return null;
        throw err;
      }
    },
  };
}
