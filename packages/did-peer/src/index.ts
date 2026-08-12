/**
 * @estoc/did-peer — did:peer:2 and did:peer:4, plus conversion to the flat
 * DIDDoc shape didcomm-rust expects.
 *
 * Everything here is pure encoding/decoding: the document *is* the identifier,
 * so resolution never touches the network. One source runs unchanged in Node,
 * workerd, and the browser (sha256 from @noble/hashes, base64 via atob/btoa).
 *
 * What stays out, by design: resolver composition (did:web, caching, pinning),
 * WASM loading, and secrets handling — those are application policy.
 */

export type {
  DIDDoc,
  Secret,
  Service,
  ServiceEndpoint,
  VerificationMethod,
} from "./types.js";

export {
  base64urlToBytes,
  base64urlToUtf8,
  bytesToBase64url,
  utf8ToBase64url,
} from "./base64.js";

export { isPeerDID2, PeerDID2Error, resolve as resolvePeer2 } from "./did-peer-2.js";

export {
  encodeLongForm,
  encodeShortForm,
  isLongForm,
  isPeerDID4,
  isShortForm,
  LONG_FORM_RE,
  longToShort,
  PeerDID4Error,
  resolveLongForm,
  resolveShortForm,
  resolveShortFormFromDocument,
  SHORT_FORM_RE,
  validateInputDocument,
  type PeerDocument,
} from "./did-peer-4.js";

export { DIDDocConversionError, toDIDCommDIDDoc } from "./did-doc.js";

export { resolveDIDCommDoc } from "./resolve.js";
