/**
 * What the runtime does over the whole fold: the retention it hands
 * the event store for collection, export and import; the erasure of a
 * message and the closure that keeps an erasure complete when a later
 * event names roots the erase did not. Each decision is a pure function
 * of the fold, exported as such, and each procedure takes the writer
 * lock, scans, decides, commits what it decided in one batch and
 * collects.
 */

import { heldRootsOf, type Collected, type Event, type HeldRoots, type RetainedRoots, type VaultRuntime } from "@estoc/event-store/v3";

import { erased } from "./fold/held.js";
import { scanVault, type ScanOptions, type VaultFold } from "./fold/vault.js";
import type { Keys } from "./identity.js";
import { vaultDraft, type VaultDraft } from "./schema.js";
import type { Cid, MessageId } from "./types.js";

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- retention -----------------------------------------------------------

/** The vault's retention as the event store asks for it: folded from the vault it is handed, with the seed's checks when the keys are here. */
export function vaultRetention(keys: Keys | null, options: ScanOptions = {}): RetainedRoots {
  return async (vault) => (await scanVault(vault, keys, options)).retained;
}

/** The roots the vault holds, as a keep set for collection, an export or a validation. */
export function vaultHeldRoots(keys: Keys | null, options: ScanOptions = {}): HeldRoots {
  return heldRootsOf(vaultRetention(keys, options));
}

/** One collection pass: the keep set folded under the lock. */
export function collectGarbage(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Collected> {
  return runtime.collect(vaultHeldRoots(keys, options));
}

// ---- erasure -------------------------------------------------------------

/** Every root the events of each message name, by message ID: what its erasure must release. */
function rootsByMessage(fold: VaultFold): Map<MessageId, Set<Cid>> {
  const roots = new Map<MessageId, Set<Cid>>();
  for (const type of ["message.out", "message.in", "message.prepared"] as const) {
    for (const event of fold.set.of(type)) {
      const named = roots.get(event.data.messageId);
      if (named === undefined) roots.set(event.data.messageId, new Set(event.roots));
      else for (const root of event.roots) named.add(root);
    }
  }
  return roots;
}

function unreleased(fold: VaultFold, roots: Map<MessageId, Set<Cid>>, messageId: MessageId): Cid[] {
  return [...(roots.get(messageId) ?? [])].filter((root) => !erased(fold.erasures, messageId, root)).sort();
}

/** One erase per message that still names a root no erasure of it released, in message order. */
export function eraseDrafts(fold: VaultFold, messageIds: Iterable<MessageId>, because: string): VaultDraft<"message.erased">[] {
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const messageId of [...new Set(messageIds)].sort()) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because }));
  }
  return drafts;
}

/**
 * The equivalent erase each erased message is owed for roots learned
 * since its erasure — a later observation's, a package prepared after
 * — under the reason of the first erasure in canonical order, one
 * erase per message ID.
 */
export function erasureClosure(fold: VaultFold): VaultDraft<"message.erased">[] {
  const because = new Map<MessageId, string>();
  for (const event of fold.set.of("message.erased")) if (!because.has(event.data.messageId)) because.set(event.data.messageId, event.data.because);
  const roots = rootsByMessage(fold);
  const drafts: VaultDraft<"message.erased">[] = [];
  for (const [messageId, reason] of [...because].sort(([a], [b]) => cmp(a, b))) {
    const dropCids = unreleased(fold, roots, messageId);
    if (dropCids.length > 0) drafts.push(vaultDraft("message.erased", { messageId, dropCids, because: reason }));
  }
  return drafts;
}

export interface Committed {
  readonly events: Event[];
  readonly collected: Collected;
}

async function decide(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions, drafts: (fold: VaultFold) => VaultDraft[]): Promise<Committed> {
  return runtime.locked(async (held) => {
    const batch = drafts(await scanVault(held, keys, options));
    const events = batch.length === 0 ? [] : await held.commit([], batch);
    return { events, collected: await held.collect(vaultHeldRoots(keys, options)) };
  });
}

/** Erase a message: every root its events and its packages still retain, in one commit, then collect. Nothing left to release commits nothing. */
export function eraseMessage(runtime: VaultRuntime, keys: Keys | null, messageId: MessageId, because = "user", options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, (fold) => eraseDrafts(fold, [messageId], because));
}

/** Append the equivalent erases later events made erased messages owed, then collect. */
export function closeErasures(runtime: VaultRuntime, keys: Keys | null, options: ScanOptions = {}): Promise<Committed> {
  return decide(runtime, keys, options, erasureClosure);
}
