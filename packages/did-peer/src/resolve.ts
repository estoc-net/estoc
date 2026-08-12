import { isPeerDID2, resolve as resolvePeer2 } from "./did-peer-2.js";
import { isPeerDID4, isLongForm, resolveLongForm } from "./did-peer-4.js";
import { toDIDCommDIDDoc } from "./did-doc.js";
import type { DIDDoc } from "./types.js";

/**
 * Resolve a did:peer:2 or did:peer:4 straight to the DIDDoc shape didcomm-rust
 * expects. Both methods carry their document in the identifier, so resolving is
 * pure decoding — no fetch, no cache, nothing async but the signature the
 * didcomm WASM wants. Applications that also resolve fetched methods (did:web)
 * compose their own resolver and fall through to this one for peers.
 */

export async function resolveDIDCommDoc(did: string): Promise<DIDDoc | null> {
  let document: Record<string, unknown> | null = null;

  try {
    if (isPeerDID2(did)) {
      document = resolvePeer2(did);
    } else if (isPeerDID4(did) && isLongForm(did)) {
      document = resolveLongForm(did);
    }
  } catch {
    return null;
  }

  if (document === null) {
    return null;
  }

  try {
    return toDIDCommDIDDoc(document);
  } catch {
    return null;
  }
}
