import type { AgentStatus, DeliveryState, DeliveryStatus, ImportOutcome, Invitation } from "@estoc/agent-core";
import type { Entry } from "./entries.js";

export type { AgentStatus, DeliveryState, DeliveryStatus, Entry, ImportOutcome, Invitation };

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

/** An invitation this identity issued: a link for one person, open until someone takes it. */
export interface InvitationView {
  id: string;
  /** what the link says it is for */
  goal: string;
  createdAt: string;
  /** the URL to hand over — this deployment's origin carrying `?_oob=`; every Estoc client reads only the parameter */
  url: string;
  /** whether the mediator has accepted its DID yet — before that, the link leads nowhere */
  ready: boolean;
  /** the cid of the contact who took it, once someone has */
  takenBy: string | null;
}

export interface Identity {
  name: string;
  /** the mediator this identity is reached through; null until one is chosen */
  mediatorDid: string | null;
  /** the public DID, minted after mediate-grant with the routing DID as its service */
  did: string | null;
  contacts: Contact[];
  invitations: InvitationView[];
  /** every log record, homed to its contact; what a thread shows of them is the renderers' call */
  messages: Entry[];
  /**
   * The delivery log folded, by mid: what became of each message of ours.
   * A sent entry with no state here is pending — written, not yet tried.
   * Received entries have none.
   */
  deliveries: Record<string, DeliveryState>;
}

/**
 * The app's screens, in the order a fresh install meets them:
 * booting → (elsewhere: another tab has the vault) → onboarding (no vault)
 * | locked (a vault, no cached seed) → open.
 */
export type Phase = "booting" | "elsewhere" | "onboarding" | "locked" | "open";
