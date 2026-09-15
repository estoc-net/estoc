/**
 * The shape of every procedure that writes the vault: under the writer
 * lock, the fold read fresh through the held view, the decision taken
 * over it, and what was decided committed in one batch. Nothing
 * decided over a fold read outside the lock is committed: what the
 * events say may have changed since.
 *
 * A procedure that has to talk to the mediator runs its round trips
 * outside the writer lock, since no lock should wait on the network;
 * what it needs instead is that no other procedure talks to the same
 * account meanwhile, so that two of them cannot cross — one removing
 * what the other just registered. `serially` is that: one procedure
 * at a time per account of a runtime, whichever link it runs over. It
 * holds off no vault write: a DID can be created while the answer is
 * awaited, which is why what is committed is still decided over the
 * fold read under the lock.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { readVaultEvent, scanVault, type Keys, type VaultDraft, type VaultEvent, type VaultFold } from "@estoc/vault/v3";

const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Run `work` after every earlier `serially` call for the same `owner`
 * and `key` has settled, and before every later one. The queue keeps
 * only the tail of what is still running, as a promise of nothing:
 * neither a result nor a key outlives the work it ordered.
 */
export function serially<T>(owner: object, key: string, work: () => Promise<T>): Promise<T> {
  let byKey = queues.get(owner);
  if (byKey === undefined) {
    byKey = new Map();
    queues.set(owner, byKey);
  }
  const queue = byKey;
  const previous = queue.get(key) ?? Promise.resolve();
  const running = previous.then(work, work);
  const tail: Promise<void> = running.then(
    () => undefined,
    () => undefined
  );
  queue.set(key, tail);
  void tail.then(() => {
    if (queue.get(key) !== tail) return;
    queue.delete(key);
    if (queue.size === 0) queues.delete(owner);
  });
  return running;
}

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
