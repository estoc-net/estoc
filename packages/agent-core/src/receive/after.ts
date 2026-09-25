/**
 * What follows a receipt, once the observation is durably committed:
 * independent of the pickup acknowledgement, which the durable receipt
 * alone earns, and run again by an open over everything received
 * before, since a crash may fall between a receipt and this, and by
 * whatever brings evidence an observation waited for — a resolution a
 * preparation commits, an import the host tells the agent of — under
 * the lock that brought it. The fold
 * has already judged every observation: whether the proof it carried
 * verifies, and what its `ack` earns. One pass under the lock records
 * what the vault owes on its own, in the order it is owed: first the
 * admissions, in first-receipt order and round by round, so that each
 * candidate is judged against what the earlier ones admitted, and
 * only then, over the fold as the admissions left it, a one-use
 * invitation consumed by the first eligible admitted receipt and a
 * peer's acknowledgement of an outbound. `admitted`, `consumed` and
 * `acknowledged` hold whatever this pass recorded, an earlier
 * observation's included, while `cid` only selects what is reported
 * of the observation in hand: its proof and its disposition, left as
 * diagnostics in the trace when the one did not verify or the other
 * did not admit it. Nothing here is sent. An automatic reply is an
 * operation's effect, decided elsewhere over the same fold, and
 * neither admission, consumption nor acknowledgement grants it
 * anything.
 */

import type { Held, VaultRuntime } from "@estoc/event-store";
import { admitReceipts, consumptionDrafts, readVaultEvent, scanVault, type Disposition, type EventReference, type Keys, type Status, type VaultEvent, type VaultFold } from "@estoc/vault";

import { note, type AgentTrace } from "../trace.js";
import { acknowledgementDrafts } from "./acks.js";

/** What one pass over the whole fold recorded of what the vault owes on its own. */
export interface Owed {
  admitted: VaultEvent<"message.admitted">[];
  consumed: VaultEvent<"invitation.consumed">[];
  acknowledged: VaultEvent<"delivery.acknowledged">[];
}

export interface AfterReceipt extends Owed {
  /** what continuity made of the proof the observation carried; `not-present` for one that carried none */
  proof: Status;
  /** what the observation is to the application once the pass is done */
  disposition: Disposition;
}

export interface AfterReceiptOptions {
  /** a proof that did not verify, or an observation the pass did not admit, goes to the `diag` stream */
  trace?: AgentTrace;
}

export async function afterReceipt(runtime: VaultRuntime, keys: Keys, cid: EventReference<"message.in">, options: AfterReceiptOptions = {}): Promise<AfterReceipt> {
  const { fold, ...owed } = await pass(runtime, keys);
  const trace = options.trace ?? null;
  const proof = fold.continuity.status(cid);
  if (proof.status !== "verified" && proof.status !== "not-present") await note(trace, { stream: "diag", what: "proof", data: { cid, ...proof } });
  const disposition = fold.dispositions.disposition(cid);
  if (disposition.status !== "admitted") await note(trace, { stream: "diag", what: "admission", data: { cid, ...disposition } });
  return { proof, disposition, ...owed };
}

/** The same pass with no observation in hand: an open's, over whatever a crash left between a receipt and its pass; the host's, once it brought evidence. */
export async function recordOwed(runtime: VaultRuntime, keys: Keys): Promise<Owed> {
  const { admitted, consumed, acknowledged } = await pass(runtime, keys);
  return { admitted, consumed, acknowledged };
}

function pass(runtime: VaultRuntime, keys: Keys): Promise<Owed & { fold: VaultFold }> {
  return runtime.locked((held) => recordOwedUnderLock(held, keys));
}

/** The pass for a caller that holds the writer lock already and has just committed evidence under it: the fold returned is the one the pass left, for whatever the caller decides next. */
export async function recordOwedUnderLock(held: Held, keys: Keys): Promise<Owed & { fold: VaultFold }> {
  const { fold, events: admitted } = await admitReceipts(held, await scanVault(held, keys));
  const drafts = [...consumptionDrafts(fold), ...acknowledgementDrafts(fold)];
  const events = drafts.length === 0 ? [] : (await held.commit([], drafts)).map(readVaultEvent);
  return {
    fold,
    admitted,
    consumed: events.filter((event): event is VaultEvent<"invitation.consumed"> => event.type === "invitation.consumed"),
    acknowledged: events.filter((event): event is VaultEvent<"delivery.acknowledged"> => event.type === "delivery.acknowledged"),
  };
}
