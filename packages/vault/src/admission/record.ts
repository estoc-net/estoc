/**
 * The pass that records the admissions a vault owes, dispatching
 * nothing: run by every receipt, by an open over whatever a crash left
 * between a receipt and its pass, and by whatever brings evidence an
 * observation waited for — a preparation's resolution, an import the
 * host tells of. The fold judges every observation; this pass only
 * commits what it says is owed, in canonical event order and round by
 * round, each round one commit, so a crash leaves whole rounds and the
 * next pass starts from what is durable.
 */

import type { Held, VaultRuntime } from "@estoc/event-store";

import { foldVault, scanVault, type FoldOptions, type ScanOptions, type VaultFold } from "../fold/vault.js";
import type { Keys } from "../identity.js";
import { readVaultEvent, vaultDraft, type VaultDraft, type VaultEvent } from "../schema.js";
import type { EventCid, EventReference, MessageId } from "../types.js";

/**
 * The admissions one round of the ordered pass records: of each
 * input, the first candidate observation in canonical event order that
 * may be admitted now. Only one observation of an input is taken per
 * round, since the next of the same input is judged against the
 * intent this one admits — the same intent is admitted in the next
 * round, another is refused as the contradiction it is — while
 * observations of different inputs are independent. A refused or
 * invalid candidate is passed over, and one waiting for evidence holds
 * up nothing behind it.
 */
export function admissionDrafts(fold: VaultFold): VaultDraft<"message.admitted">[] {
  const drafts: VaultDraft<"message.admitted">[] = [];
  const taken = new Set<MessageId>();
  for (const { source, eligibility } of fold.dispositions.candidates) {
    if (eligibility.status !== "eligible" || taken.has(source.event.data.messageId)) continue;
    taken.add(source.event.data.messageId);
    drafts.push(vaultDraft("message.admitted", { sourceEventCid: source.event.cid as EventReference<"message.in"> }));
  }
  return drafts;
}

export interface Admitted {
  /** the fold over the set as the pass left it: what any dependent decision under the same lock reads */
  readonly fold: VaultFold;
  readonly events: VaultEvent<"message.admitted">[];
}

/**
 * The ordered pass under a lock already held: round after round, the
 * admissions the fold owes are committed, the committed events added
 * to the fold's set and the fold read again over it, until a round
 * owes none. A commit that fails ends the pass where it is, the rounds
 * before it durable. The fold handed in is superseded by the one
 * returned. An admission that is not effective once committed is a
 * fault of the fold, not something to record again.
 */
export async function admitReceipts(held: Held, fold: VaultFold, options: FoldOptions = {}): Promise<Admitted> {
  const events: VaultEvent<"message.admitted">[] = [];
  const drafted = new Set<EventCid>();
  for (;;) {
    const drafts = admissionDrafts(fold);
    if (drafts.length === 0) return { fold, events };
    for (const draft of drafts) {
      if (drafted.has(draft.data.sourceEventCid)) throw new Error(`the admission of ${draft.data.sourceEventCid} was recorded and did not take effect`);
      drafted.add(draft.data.sourceEventCid);
    }
    const committed = (await held.commit([], drafts)).map(readVaultEvent) as VaultEvent<"message.admitted">[];
    events.push(...committed);
    for (const event of committed) fold.set.add(event);
    fold = foldVault(fold.set, fold.checks, options);
  }
}

/** The pass under the lock it takes itself, over the vault as it stands. */
export function reconcileAdmissions(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<VaultEvent<"message.admitted">[]> {
  return runtime.locked(async (held) => (await admitReceipts(held, await scanVault(held, keys, options), options)).events);
}
