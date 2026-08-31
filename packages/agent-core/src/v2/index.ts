/**
 * @estoc/agent-core/v2 — the agent over the version-2 vault
 * (`@estoc/vault/v2`, docs/vault-events.md), built beside the v1 agent
 * until it replaces it. Opening and creating, the records a caller
 * reads, the trace of what this device saw, and the channel an envelope
 * proves; the rest follows, one module at a time.
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
