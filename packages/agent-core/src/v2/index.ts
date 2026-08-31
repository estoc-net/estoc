/**
 * @estoc/agent-core/v2 — the agent over the version-2 vault
 * (`@estoc/vault/v2`, docs/vault-events.md), built beside the v1 agent
 * until it replaces it. Opening and creating, the records a caller
 * reads, the trace of what this device saw, the channel an envelope
 * proves, the keys this device holds, the line to the mediator, the
 * rituals over it, the pickup of what it holds for us, the handlers
 * for what the mail says and what one opened envelope becomes; the rest
 * follows, one module at a time.
 */

export { createVault, inspectVault, openVault, type CreateVaultOptions, type Inspected, type OpenOptions, type PeerVault } from "./identity.js";
export { mintPeerDid, type PeerIdentity } from "../identity/peer.js";
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
export { Inbound, type Handled, type InboundOptions } from "./inbound.js";
export { GOAL_CONNECT, invitationMessage, invitationUrl, parseInvitation, type Invitation } from "./oob.js";
export {
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
