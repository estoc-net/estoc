/**
 * @estoc/agent-core/v2 — the agent over the version-2 vault
 * (`@estoc/vault/v2`, docs/vault-events.md), built beside the v1 agent
 * until it replaces it. Opening and creating for now; the rest follows,
 * one module at a time.
 */

export { createVault, inspectVault, openVault, type CreateVaultOptions, type Inspected, type OpenOptions, type PeerVault } from "./identity.js";
export { mintPeerDid, type PeerIdentity } from "../identity/peer.js";
