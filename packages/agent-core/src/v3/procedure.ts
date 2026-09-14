/**
 * The shape of every procedure that writes the vault: under the writer
 * lock, the fold read fresh through the held view, the decision taken
 * over it, and what was decided committed in one batch. Nothing
 * decided over a fold read outside the lock is committed: what the
 * events say may have changed since.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { readVaultEvent, scanVault, type Keys, type VaultDraft, type VaultEvent, type VaultFold } from "@estoc/vault/v3";

export interface Decided {
  /** the fold the decision was taken over */
  fold: VaultFold;
  /** the events committed; none when the decision was to commit nothing */
  events: VaultEvent[];
}

/** One locked step: scan, decide, commit. `decide` returns the drafts to commit, or none when the fold already says what it would say. */
export async function decide(runtime: VaultRuntime, keys: Keys, choose: (fold: VaultFold) => VaultDraft[] | Promise<VaultDraft[]>): Promise<Decided> {
  return runtime.locked(async (held) => {
    const fold = await scanVault(held, keys);
    const drafts = await choose(fold);
    const events = drafts.length === 0 ? [] : (await held.commit([], drafts)).map(readVaultEvent);
    return { fold, events };
  });
}
