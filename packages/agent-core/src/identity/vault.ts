import type { VaultBackend, CreateVaultOptions, VaultOptions } from "@estoc/vault";
import { Vault } from "@estoc/vault";

import { mintPeerDid, type PeerIdentity } from "./peer.js";

/**
 * The vault as the agent knows it: `@estoc/vault`'s format, minting
 * did:peer:4 (`mintPeerDid`) — Multikey long form, one Ed25519 and one
 * X25519 key, the mediator's routing DID as the service when there is
 * one. The format package records the DIDs; this binding decides what
 * they are.
 */
export type PeerVault = Vault<PeerIdentity>;

export const PEER_DIDS = { mint: mintPeerDid } as const;

/** `Vault.open` with did:peer:4 minting; `options` is the device's side of it (the trace policy). */
export function openVault(
  backend: VaultBackend,
  options: Omit<VaultOptions<PeerIdentity>, "mint"> = {}
): Promise<PeerVault> {
  return Vault.open(backend, { ...options, ...PEER_DIDS });
}

/** `Vault.create` with did:peer:4 minting; `mediatorDid` names one now, `Agent.setMediator` later. */
export function createVault(
  backend: VaultBackend,
  options: Omit<CreateVaultOptions<PeerIdentity>, "mint">
): Promise<PeerVault> {
  return Vault.create(backend, { ...options, ...PEER_DIDS });
}
