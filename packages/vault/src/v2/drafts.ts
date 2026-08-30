/**
 * Drafts of the vault's events (vault-events.md): what `append` takes,
 * one constructor per type, `blobs` filled in where the type references
 * roots (a skeleton lists its body and attachments twice, §3.1: once for
 * the collector, once for the reader).
 */

import type { Draft } from "@estoc/event-store";

import type { VaultData, VaultType } from "./types.js";

export type VaultDraft<T extends VaultType = VaultType> = Draft<VaultData[T]> & { type: T };

function draft<T extends VaultType>(type: T, data: VaultData[T], blobs?: string[]): VaultDraft<T> {
  return blobs === undefined ? { type, data } : { type, blobs, data };
}

export const drafts = {
  // ---- channels (§3.1)
  channelFirstSeen: (data: VaultData["channel.firstSeen"]) => draft("channel.firstSeen", data),
  messageIn: (data: VaultData["message.in"]) => draft("message.in", data, [data.body, ...data.attachments]),
  messageOut: (data: VaultData["message.out"]) => draft("message.out", data, [data.body, ...data.attachments]),
  deliveryAttempted: (data: VaultData["delivery.attempted"]) => draft("delivery.attempted", data),
  deliveryHeld: (data: VaultData["delivery.held"]) => draft("delivery.held", data),
  profileNameClaimed: (data: VaultData["profile.nameClaimed"]) => draft("profile.nameClaimed", data),
  profileShared: (data: VaultData["profile.shared"]) => draft("profile.shared", data),
  peerResolved: (data: VaultData["peer.resolved"]) => draft("peer.resolved", data),
  peerRotated: (data: VaultData["peer.rotated"]) => draft("peer.rotated", data),
  /** an erase references nothing (§8.1): `blobs` stays `[]` */
  messageErased: (data: VaultData["message.erased"]) => draft("message.erased", data),
  // ---- identity and devices (§5)
  deviceMinted: () => draft("device.minted", {}),
  didMinted: (data: VaultData["did.minted"]) => draft("did.minted", data),
  didRegistered: (data: VaultData["did.registered"]) => draft("did.registered", data),
  didPublished: (data: VaultData["did.published"]) => draft("did.published", data),
  didRetired: (data: VaultData["did.retired"]) => draft("did.retired", data),
  mediationCreated: (data: VaultData["mediation.created"]) => draft("mediation.created", data),
  mediationGranted: (data: VaultData["mediation.granted"]) => draft("mediation.granted", data),
  mediationRetired: (data: VaultData["mediation.retired"]) => draft("mediation.retired", data),
  identityLabel: (data: VaultData["identity.label"]) => draft("identity.label", data),
  deviceLabel: (data: VaultData["device.label"]) => draft("device.label", data),
  deviceRetired: (data: VaultData["device.retired"]) => draft("device.retired", data),
  /** `object` names, never references (§5): `blobs` stays `[]` */
  extensionInstalled: (data: VaultData["extension.installed"]) => draft("extension.installed", data),
  extensionRemoved: (data: VaultData["extension.removed"]) => draft("extension.removed", data),
  extensionPurged: (data: VaultData["extension.purged"]) => draft("extension.purged", data),
  // ---- contacts (§6)
  contactCreated: (data: VaultData["contact.created"]) => draft("contact.created", data),
  contactPetname: (data: VaultData["contact.petname"]) => draft("contact.petname", data),
  contactFlag: (data: VaultData["contact.flag"]) => draft("contact.flag", data),
  contactUseKey: (data: VaultData["contact.useKey"]) => draft("contact.useKey", data),
  contactAttached: (data: VaultData["contact.attached"]) => draft("contact.attached", data),
  contactDetached: (data: VaultData["contact.detached"]) => draft("contact.detached", data),
  contactMerged: (data: VaultData["contact.merged"]) => draft("contact.merged", data),
  contactDeleted: (data: VaultData["contact.deleted"]) => draft("contact.deleted", data),
} as const;
