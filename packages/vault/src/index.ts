/**
 * @estoc/vault — the vault's events and folds (docs/vault-events.md).
 *
 * What each event type's `data` holds, the peer-key fingerprint, the
 * folds (attribution, contact state, my DIDs and devices, invitations,
 * deliveries, the keep-set), the procedures (erase, delete, merge), and
 * the keystore glue. Runs over any `@estoc/event-store` stores; the
 * folder is one of them.
 */

export type {
  AttachCause,
  ChannelFirstSeen,
  ChannelKey,
  ContactAttached,
  ContactCreated,
  ContactDeleted,
  ContactDetached,
  ContactFlag,
  ContactMerged,
  ContactPetname,
  ContactUseKey,
  DeliveryAttempted,
  DeliveryHeld,
  DeliveryOutcome,
  DeviceLabel,
  DeviceMinted,
  DeviceRetired,
  DidMinted,
  DidPublished,
  DidRegistered,
  DidRetired,
  EnvelopeKind,
  EraseCause,
  ExtensionInstalled,
  ExtensionPurged,
  ExtensionRemoved,
  IdentityLabel,
  MediationCreated,
  MediationGranted,
  MediationRetired,
  MessageErased,
  MessageIn,
  MessageOut,
  PeerResolved,
  PeerRotated,
  ProfileNameClaimed,
  ProfileShared,
  PublishedAs,
  Skeleton,
  Uses,
  VaultData,
  VaultEvent,
  VaultType,
} from "./types.js";
export {
  CHANNEL_DECISIONS,
  DID_KEY_PREFIX,
  KEY_ANCHOR,
  KEY_NAME,
  MEDIATION_KEY_PREFIX,
  Malformed,
  OBSERVATIONS,
  PEER_KEY,
  VAULT_TYPES,
  channelId,
  didKeyName,
  isMediationKey,
  isVaultType,
  mediationKeyName,
  readVaultEvent,
  sameChannel,
} from "./types.js";

export { fingerprint, isPeerKey, peerKeyOf } from "./peer-key.js";

export { Components, EventSet, latest } from "./set.js";

export {
  VaultFold,
  type Attribution,
  type Channel,
  type Attached,
  type Contact,
  type ContactKey,
  type DeletedContact,
  type Delivery,
  type DeliveryStatus,
  type Device,
  type Extension,
  type Invitation,
  type Mediation,
  type Message,
  type MyKey,
  type Published,
  type TheirDid,
} from "./fold.js";

export { drafts, type VaultDraft } from "./drafts.js";

export {
  allRoots,
  collectBlobs,
  deleteContact,
  eraseMessage,
  heldRoots,
  holdImported,
  importPolicy,
  noteFirstSeen,
  notePeerResolved,
  readRoot,
  record,
  recordAll,
  recordMessage,
  sweepDeleted,
  type Absence,
  type Deleted,
  type InboundSkeleton,
  type OutboundSkeleton,
  type VaultSide,
} from "./procedures.js";

export { Keys, type KeysOptions, type MintDid, type MintedDid } from "./identity.js";

export { createFolderVault, openFolderVault, type FolderOptions, type Opened } from "./folder.js";
