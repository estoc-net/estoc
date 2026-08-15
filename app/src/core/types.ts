import type { AgentStatus, ChatMessage, ImportOutcome } from "@estoc/agent-core";

export type { AgentStatus, ChatMessage, ImportOutcome };

/**
 * What the UI renders: reactive views mirrored from the vault. The vault
 * (in OPFS, via @estoc/agent-core) is the record; these are projections
 * kept in step by agent events.
 */

export interface Contact {
  /** the contact's cid in the vault */
  cid: string;
  /** their current DID */
  did: string;
  /** our DID toward them — pairwise, minted on the first message; null before */
  myDid: string | null;
  /** our petname for them */
  label: string;
  /**
   * The displayName the contact announced over user-profile/1.0 — what they
   * call themself, which is not what we necessarily call them, and never a
   * verified claim.
   */
  claimedName?: string;
}

export interface Identity {
  name: string;
  /** the mediator this identity is reached through; null until one is chosen */
  mediatorDid: string | null;
  /** the public DID, minted after mediate-grant with the routing DID as its service */
  did: string | null;
  contacts: Contact[];
  messages: ChatMessage[];
}

/**
 * The app's screens, in the order a fresh install meets them:
 * booting → (elsewhere: another tab has the vault) → onboarding (no vault)
 * | locked (a vault, no cached seed) → open.
 */
export type Phase = "booting" | "elsewhere" | "onboarding" | "locked" | "open";
