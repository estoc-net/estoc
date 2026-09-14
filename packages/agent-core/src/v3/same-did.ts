import { isLongForm, longToShort } from "@estoc/did-peer";

/** A DID in the one spelling every peer agrees on: the short form of a did:peer:4, whose long form carries the same hash, and any other DID as it is. */
export function canonicalDid(did: string): string {
  return isLongForm(did) ? longToShort(did) : did;
}

/** Do the two name the same DID, whichever spelling each uses? */
export function sameDid(a: string, b: string): boolean {
  return a === b || canonicalDid(a) === canonicalDid(b);
}
