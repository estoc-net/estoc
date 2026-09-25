/**
 * The early private-address policy: an address we disclosed is one
 * anyone may have; the first established application input a peer
 * writes to it selects a fresh private successor toward that peer,
 * decided over the input as its source and announced to the peer
 * alone. The policy is applied only while the input is live, in the
 * receipt's own call chain, and applies to disclosure alone: a DID
 * reused across channels, one a peer's rotation led to, or one never
 * disclosed selects nothing, and separating such an address is a
 * manual rotation. A pair whose predecessor already decided reuses
 * that decision, whatever verified it since, and selects no second
 * successor and no other notification.
 */

import type { VaultRuntime } from "@estoc/event-store";
import { channelPolicy, decisionFor, kindOf, scanVault, type Decision, type EventReference, type Keys, type VaultEvent, type VaultFold } from "@estoc/vault";

import type { LiveInput } from "./action.js";
import { rotate, type RotateOptions, type Rotated, type RotationTarget } from "./rotate.js";

export type PrivacyPolicy = { status: "rotate"; target: RotationTarget } | { status: "reuse"; decision: Decision } | { status: "none"; because: string };

/** What the policy makes of an observation over the fold: pure, and read again under the lock by the rotation it selects. */
export function privacyPolicy(fold: VaultFold, cid: EventReference<"message.in">): PrivacyPolicy {
  const none = (because: string): PrivacyPolicy => ({ status: "none", because });
  const source = fold.channels.sources.get(cid);
  if (source === undefined) return none("the observation is not here");
  if (source.channel === null || source.localDidId === null) return none("the observation is anonymous or in no channel");
  const witness = fold.continuity.witness(cid);
  if (witness.status !== "complete") return none(`the observation is no complete witness: ${witness.because}`);
  const execution = fold.inbound.ofSource(cid);
  if (execution === null) return none("the observation is in no input here");
  if (execution.status.status !== "complete") return none(`the input is not established: ${execution.status.because}`);
  const kind = kindOf(source.event.data);
  if (kind !== "application") return none(`a control input selects no rotation: it is ${kind}`);
  const entity = fold.routes.dids.get(source.localDidId);
  if (entity === undefined || entity.disclosures.length === 0) return none("the local DID is not disclosed");
  const denied = channelPolicy(fold, source.channel, { automatic: true });
  if (denied !== null) return none(denied);
  const existing = decisionFor(fold, source.channel.localDid, source.channel.peerDid);
  if (existing.status === "reuse") return { status: "reuse", decision: existing.decision };
  if (existing.status !== "none") return none(existing.because);
  return { status: "rotate", target: { localDidId: entity.didId, peerDid: source.channel.peerDid, sourceEventCid: cid } };
}

export type PrivateAddress =
  | { outcome: "rotated"; rotation: Rotated }
  | { outcome: "reused"; decision: VaultEvent<"did.rotationSelected"> }
  | { outcome: "none"; because: string };

/**
 * The policy applied to a live input: the rotation it selects is
 * checked again under the writer lock, where the decision and the
 * notification's intent are committed, and the notification's one
 * transport call is made once the lock is released. A decision
 * recorded meanwhile is reused as it is. The successor is a fresh
 * entity: the rotation refuses an address recorded before, disclosed
 * or not, as the policy's successor.
 */
export async function privateAddress(runtime: VaultRuntime, keys: Keys, live: LiveInput, options: RotateOptions): Promise<PrivateAddress> {
  const policy = privacyPolicy(await scanVault(runtime.vault, keys), live.cid);
  if (policy.status === "none") return { outcome: "none", because: policy.because };
  if (policy.status === "reuse") return { outcome: "reused", decision: policy.decision.event };
  const rotation = await rotate(runtime, keys, policy.target, options);
  return rotation.existed ? { outcome: "reused", decision: rotation.decision } : { outcome: "rotated", rotation };
}
