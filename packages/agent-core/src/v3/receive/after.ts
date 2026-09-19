/**
 * What follows a receipt, once the observation is durably committed:
 * independent of the pickup acknowledgement, which the durable receipt
 * alone earns, and run again by an open over everything received
 * before, since a crash may fall between a receipt and this. The fold
 * has already judged every observation: whether the proof it carried
 * verifies, and what its `ack` earns. This records the two things the
 * vault owes on its own — a one-use invitation consumed by the first
 * eligible receipt, and a peer's acknowledgement of an outbound — in
 * one commit under the lock, over the fold read there, for the whole
 * fold: `consumed` and `acknowledged` hold whatever this pass
 * recorded, an earlier observation's included, while `eventId` only
 * selects the proof reported and, when it did not verify, left as a
 * diagnostic in the trace. Nothing here is sent. An automatic reply is
 * an operation's effect, decided elsewhere over the same fold, and
 * neither consumption nor acknowledgement grants it anything.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { consumptionDrafts, type EventReference, type Keys, type Status, type VaultEvent } from "@estoc/vault/v3";

import { decide } from "../procedure.js";
import { note, type AgentTrace } from "../trace.js";
import { acknowledgementDrafts } from "./acks.js";

export interface AfterReceipt {
  /** what continuity made of the proof the observation carried; `not-present` for one that carried none */
  proof: Status;
  consumed: VaultEvent<"invitation.consumed">[];
  acknowledged: VaultEvent<"delivery.acknowledged">[];
}

export interface AfterReceiptOptions {
  /** a proof that did not verify goes to the `diag` stream */
  trace?: AgentTrace;
}

export async function afterReceipt(runtime: VaultRuntime, keys: Keys, eventId: EventReference<"message.in">, options: AfterReceiptOptions = {}): Promise<AfterReceipt> {
  const { fold, events } = await decide(runtime, keys, (fold) => [...consumptionDrafts(fold), ...acknowledgementDrafts(fold)]);
  const proof = fold.continuity.status(eventId);
  if (proof.status !== "verified" && proof.status !== "not-present") await note(options.trace ?? null, { stream: "diag", what: "proof", data: { eventId, ...proof } });
  return {
    proof,
    consumed: events.filter((event): event is VaultEvent<"invitation.consumed"> => event.type === "invitation.consumed"),
    acknowledged: events.filter((event): event is VaultEvent<"delivery.acknowledged"> => event.type === "delivery.acknowledged"),
  };
}
