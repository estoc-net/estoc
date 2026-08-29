/**
 * @estoc/agent-core — the DIDComm v2 agent behind Estoc's clients.
 *
 * Layers, bottom up: the `.estoc` vault (`@estoc/vault`: a `VaultBackend`
 * of bytes, the format over it — config, seed keystore, contacts, message
 * log), bound here to seed-derived did:peer:4 identities (`openVault`,
 * `createVault`), protocol helpers, and the `Agent` that runs mediation,
 * pickup and live delivery for one vault. What stays out: the format
 * itself (import it from `@estoc/vault`), WASM instantiation (handed in
 * as `DidcommApi`), UI state, and how a passphrase becomes a `SeedKey`.
 */

export { mintPeerDid, type PeerIdentity } from "./identity/peer.js";
export { PEER_DIDS, createVault, openVault, type PeerVault } from "./identity/vault.js";

// DIDComm v2 specification protocols — the agent's own
export * from "./protocol/spec.js";
// community protocols the agent uses as transport
export * from "./protocol/mediation.js";
// community protocols handled as application mail, through the handler seam
export {
  type HandlerContext,
  type ProtocolHandler,
  type SendOptions,
} from "./protocol/handler.js";
export { BASIC_MESSAGE, basicmessageHandler } from "./protocol/basicmessage.js";
export {
  PROFILE,
  REQUEST_PROFILE,
  announcedName,
  shareProfile,
  userProfileHandler,
} from "./protocol/user-profile.js";
export {
  ENCRYPTED_MIME,
  PLAIN_TYP,
  didOf,
  endpointOf,
  plainMessage,
  secretsResolverFor,
  serviceUris,
  type DidcommApi,
  type IMessage,
} from "./protocol/didcomm.js";
export { resolveDid } from "./protocol/resolver.js";
export {
  OBJECT_SHARE,
  DAG_PB_MEDIA_TYPE,
  RAW_MEDIA_TYPE,
  CAR_MEDIA_TYPE,
  DEFAULT_MAX_SHARE_BYTES,
  closureOf,
  packageOf,
  openPackage,
  closureSize,
  attachmentsOf,
  blocksOf,
  verifyShare,
  missingBytes,
  objectShareHandler,
  type ObjectShareBody,
  type BlockAttachment,
  type Closure,
  type VerifiedShare,
  type PackageProblem,
  type SharePackage,
  type PackageAttachment,
} from "./protocol/object-share.js";
export { AES256_GCM_HKDF_1MB, encryptStream, decryptStream, freshKey } from "./protocol/streaming-aead.js";
export {
  BLOB_STORE_PROTOCOL,
  BLOB_PUT,
  BLOB_PUT_RESULT,
  BLOB_DELETE,
  BLOB_DELETE_RESULT,
  type BlobPlacement,
} from "./protocol/blob-store.js";
export { didHost, resolveMediatorInput } from "./protocol/mediator-input.js";
export {
  GOAL_CONNECT,
  invitationMessage,
  invitationUrl,
  parseInvitation,
  type Invitation,
} from "./protocol/oob.js";

export {
  Agent,
  type AgentEvents,
  type AgentOptions,
  type AgentStatus,
} from "./agent.js";
