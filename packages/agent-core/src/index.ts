/**
 * @estoc/agent-core — the DIDComm v2 agent behind Estoc's clients, over
 * the `.estoc` vault as `@estoc/vault` folds it (docs/vault-events.md).
 *
 * Bottom up: the folder and its events (`@estoc/event-store`,
 * `@estoc/vault`), bound here to did:peer:4 minted from a seed-derived
 * key (`openVault`, `createVault`, `inspectVault`); the protocols as the
 * specifications have them (`protocol/`: types, message shapes, the
 * checks — nothing that reads a vault); and the agent's own modules: the
 * records a caller reads, the trace of what this device saw, the channel
 * an envelope proves, the keys this device holds, the line to the
 * mediator and the rituals over it, the pickup of what it holds for us,
 * the handlers for what the mail says, what one opened envelope becomes,
 * what a message of ours becomes on its way out and the outbox it waits
 * in, and the `Agent` that runs it all as one loop. What stays out: the
 * format itself, WASM instantiation (handed in as `DidcommApi`), UI
 * state, and how a passphrase becomes a `SeedKey`.
 */

export { createVault, inspectVault, openVault, type CreateVaultOptions, type Inspected, type OpenOptions, type PeerVault } from "./identity.js";
export { mintPeerDid, type PeerIdentity } from "./identity/peer.js";

// DIDComm v2 specification protocols — the agent's own
export * from "./protocol/spec.js";
// community protocols the agent uses as transport
export * from "./protocol/mediation.js";
// the application protocols' types and shapes; their handlers are below
export { BASIC_MESSAGE } from "./protocol/basicmessage.js";
export { PROFILE, REQUEST_PROFILE, announcedName } from "./protocol/user-profile.js";
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
  DRISL_MEDIA_TYPE,
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
  envelopeKind,
  inboundPair,
  outboundPair,
  peerKeyOfMethod,
  publicKeyOf,
  publicKeyOfMethod,
  resolvedOf,
  senderOf,
  signerOf,
  type KeyOfDid,
  type Proved,
  type Unpacked,
} from "./channel.js";
export { Keyring, type MyIdentity, type Routed, type Skipped } from "./keyring.js";
export { MediatorLink, ritual, sealData, type LinkOptions, type Opened, type Sealed } from "./link.js";
export { current, establish, leave, register, registerPending, rotateStale, routedOf, type EstablishStep, type Established, type Left, type Rotated } from "./mediation.js";
export { Pickup, type Drained, type Fate, type Handle, type PickupOptions } from "./pickup.js";
export { type HandlerContext, type InboundRecord, type ProtocolHandler, type SendOptions } from "./handler.js";
export { basicmessageHandler } from "./handlers/basicmessage.js";
export { shareProfile, userProfileHandler } from "./handlers/user-profile.js";
export { keepShare, objectShareHandler } from "./handlers/object-share.js";
export { fillBlocks, stripBlocks, type Lifted } from "./lift.js";
export { Inbound, type Handled, type InboundOptions } from "./inbound.js";
export { Outbound, Outbox, type Attempted, type Composed, type OutboundOptions, type OutboxOptions } from "./outbound.js";
export { BlobRefused, buildShare, deleteBlob, fetchPackage, placePackage, putBlob, type PlacedPackage, type Placing, type ShareParts, type WireNote } from "./share.js";
export { Agent, type AgentEvents, type AgentOptions, type AgentStatus } from "./agent.js";
export { GOAL_CONNECT, invitationMessage, invitationUrl, parseInvitation, type Invitation } from "./oob.js";
export {
  attributedTo,
  contactRecord,
  didPlaceholder,
  invitationRecord,
  messageRecord,
  nameOf,
  type BodyState,
  type ContactRecord,
  type InvitationRecord,
  type MessageRecord,
  type PlainMessage,
} from "./records.js";
export {
  AgentTrace,
  TRACE_LEVELS,
  TRACE_NORMAL,
  TRACE_OFF,
  TRACE_STREAMS,
  TRACE_VERBOSE,
  isTraceLevel,
  isTraceStream,
  traceLevelOf,
  tracePolicy,
  type AgentTraceOptions,
  type TraceData,
  type TraceEvent,
  type TraceLevel,
  type TracePolicy,
  type TracePruneReport,
  type TraceStream,
} from "./trace.js";
