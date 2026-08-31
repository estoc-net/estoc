/**
 * @estoc/agent-core/v2 — the agent over the version-2 vault
 * (`@estoc/vault/v2`, docs/vault-events.md), built beside the v1 agent
 * until it replaces it. Opening and creating, and the records a caller
 * reads; the rest follows, one module at a time.
 */

export { createVault, inspectVault, openVault, type CreateVaultOptions, type Inspected, type OpenOptions, type PeerVault } from "./identity.js";
export { mintPeerDid, type PeerIdentity } from "../identity/peer.js";
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
