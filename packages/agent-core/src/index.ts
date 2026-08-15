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
export { segmentsOf, type VaultBackend } from "./backend/types.js";

export {
  CONFIG_PATH,
  CONTACTS_DIR,
  ESTOC_DIR,
  FIRST_SEGMENT,
  KEYSTORE_PATH,
  MESSAGES_DIR,
} from "./vault/layout.js";
export { parseConfig, type KeyRef, type Mediation, type VaultConfig } from "./vault/config.js";
export {
  ContactStore,
  contactFileStem,
  currentDid,
  currentMyDid,
  newContact,
  parseContact,
  type ContactRecord,
  type DidUse,
  type MyDidUse,
} from "./vault/contacts.js";
export {
  MessageLog,
  newMessageRecord,
  parseSegment,
  type DamagedLine,
  type MessageRecord,
  type PlainMessage,
} from "./vault/messages.js";
export {
  importVault,
  snapshotVault,
  type ImportOutcome,
  type VaultFiles,
} from "./vault/transfer.js";
export {
  KEY_ANCHOR,
  KEY_MEDIATOR,
  KEY_PAIRWISE_PREFIX,
  KEY_PUBLIC,
  Vault,
  type CreateVaultOptions,
} from "./vault/vault.js";

export { mintPeerDid, type PeerIdentity } from "./identity/peer.js";

export * from "./protocol/types.js";
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
export { chatView, type ChatMessage } from "./protocol/chat.js";

export {
  Agent,
  didPlaceholder,
  type AgentEvents,
  type AgentOptions,
  type AgentStatus,
} from "./agent.js";
