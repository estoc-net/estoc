import { isLongForm, longToShort } from "@estoc/did-peer";

/**
 * A DID in the one spelling every peer agrees on: the short form of a
 * did:peer:4, which its long form carries as a prefix, and any other
 * DID as it is. String work over DIDs already verified elsewhere — a
 * long form's document is checked against its hash when it is
 * resolved, not here.
 */
export function canonicalDid(did: string): string {
  return isLongForm(did) ? longToShort(did) : did;
}

export function sameDid(a: string, b: string): boolean {
  return a === b || canonicalDid(a) === canonicalDid(b);
}
