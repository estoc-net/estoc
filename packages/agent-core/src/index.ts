/**
 * @estoc/agent-core — the DIDComm v2 agent behind Estoc's clients.
 *
 * Layers, bottom up: a `VaultBackend` (bytes: OPFS, memory), the `.estoc`
 * vault format over it (config, seed keystore, contacts, message log),
 * seed-derived did:peer:4 identities, protocol helpers, and the `Agent`
 * that runs mediation, pickup and live delivery for one vault. What stays
 * out: WASM instantiation (handed in as `DidcommApi`), UI state, and how
 * a passphrase becomes a `SeedKey`.
 */

export { MemoryBackend } from "./backend/memory.js";
export { OpfsBackend } from "./backend/opfs.js";
export { segmentsOf, walk, type VaultBackend } from "./backend/types.js";

export {
  CONFIG_PATH,
  CONTACTS_DIR,
  DELIVERIES_DIR,
  ESTOC_DIR,
  INVITATIONS_DIR,
  KEYSTORE_PATH,
  MESSAGES_DIR,
} from "./vault/layout.js";
export { parseConfig, type KeyRef, type Mediation, type VaultConfig } from "./vault/config.js";
export {
  ContactStore,
  contactFile,
  currentDid,
  currentMyDid,
  didPlaceholder,
  newContact,
  previousMyDid,
  parseContact,
  type ContactRecord,
  type DidUse,
  type MyDidUse,
} from "./vault/contacts.js";
export {
  InvitationStore,
  isOpenInvitation,
  parseInvitationRecord,
  type InvitationRecord,
} from "./vault/invitations.js";
export {
  MessageLog,
  counterpartyOf,
  newMessageRecord,
  parseSegment,
  type MessageRecord,
  type PlainMessage,
} from "./vault/messages.js";
export { SegmentedLog, orderSegments, isSegment, newSegment, type DamagedLine, type LineParser } from "./vault/log.js";
export {
  DeliveryLog,
  deliveryKey,
  deliveryStatusOf,
  foldDeliveries,
  type DeliveryEvent,
  type DeliveryState,
  type DeliveryStatus,
} from "./vault/deliveries.js";
export {
  importVault,
  snapshotVault,
  type ImportOutcome,
  type VaultFiles,
} from "./vault/transfer.js";
export {
  KEY_ANCHOR,
  KEY_INVITE_PREFIX,
  KEY_MEDIATION_PREFIX,
  KEY_PAIRWISE_PREFIX,
  Vault,
  isRelationshipKey,
  mediationKeyName,
  type CreateVaultOptions,
} from "./vault/vault.js";

export { mintPeerDid, type PeerIdentity } from "./identity/peer.js";

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
