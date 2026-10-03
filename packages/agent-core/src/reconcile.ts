/**
 * One pass under the writer lock over what the vault owes on its own,
 * in the order it is owed: first the admissions, in canonical event
 * order and round by round, so that each candidate is judged against
 * what the earlier ones admitted, and only then, over the fold as the
 * admissions left it, a peer's acknowledgement of an outbound. The
 * pass is run after every receipt, by an open over everything received
 * before, since a crash may fall between a receipt and its pass, by
 * every preparation, whose resolution may be evidence an observation
 * waited for, and by whatever else brings such evidence — an import
 * the host tells the agent of — under the lock that brought it.
 * Nothing here is sent, and neither admission nor acknowledgement
 * grants a send anything: an automatic reply is an operation's effect,
 * decided elsewhere over the same fold.
 */

import type { Held, VaultRuntime } from "@estoc/event-store";
import { admitReceipts, readVaultEvent, scanVault, type Keys, type VaultEvent, type VaultFold } from "@estoc/vault";

import { acknowledgementDrafts } from "./acknowledgements.js";

/** What one pass recorded, an earlier observation's included. */
export interface Owed {
  admitted: VaultEvent<"message.admitted">[];
  acknowledged: VaultEvent<"delivery.acknowledged">[];
}

export async function recordOwed(runtime: VaultRuntime, keys: Keys): Promise<Owed> {
  const { admitted, acknowledged } = await runtime.locked((held) => recordOwedUnderLock(held, keys));
  return { admitted, acknowledged };
}

/** The pass for a caller that holds the writer lock already: the fold returned is the one the pass left, every event it committed folded in, for whatever the caller decides next. */
export async function recordOwedUnderLock(held: Held, keys: Keys): Promise<Owed & { fold: VaultFold }> {
  const { fold: admittedFold, events: admitted } = await admitReceipts(held, await scanVault(held, keys));
  const drafts = acknowledgementDrafts(admittedFold);
  const events = drafts.length === 0 ? [] : (await held.commit([], drafts)).map(readVaultEvent);
  return {
    fold: events.length === 0 ? admittedFold : await scanVault(held, keys),
    admitted,
    acknowledged: events.filter((event): event is VaultEvent<"delivery.acknowledged"> => event.type === "delivery.acknowledged"),
  };
}
