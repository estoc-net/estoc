/**
 * An acceptance the wire gave, on its way into the vault. The post
 * happened whatever becomes of the commit meant to record it, so while
 * the runtime that saw it lives, an acceptance not yet recorded is
 * recorded before anything else is done with its message: nothing
 * posted again, no other package prepared, no expired failure in its
 * place. A runtime opened afresh knows nothing of it, and may post the
 * same package again.
 */

import type { VaultRuntime } from "@estoc/event-store/v3";
import { VaultEventSet, readVaultEvent, vaultDraft, type MessageId, type PackageId, type VaultEvent } from "@estoc/vault/v3";

const unrecorded = new WeakMap<VaultRuntime, Map<MessageId, PackageId>>();

/** `delivery.submitted` for the package the wire accepted, under the lock; one already recording it is returned instead of being repeated. */
export async function recordAcceptance(runtime: VaultRuntime, messageId: MessageId, packageId: PackageId): Promise<VaultEvent<"delivery.submitted">> {
  let owed = unrecorded.get(runtime);
  if (owed === undefined) {
    owed = new Map();
    unrecorded.set(runtime, owed);
  }
  owed.set(messageId, packageId);
  const recorded = await runtime.locked(async (held) => {
    const set = await VaultEventSet.from(held.events.scan());
    const existing = set.of("delivery.submitted").find((event) => event.data.messageId === messageId && event.data.packageId === packageId);
    if (existing !== undefined) return existing;
    const [event] = (await held.commit([], [vaultDraft("delivery.submitted", { messageId, packageId })])).map(readVaultEvent);
    return event as VaultEvent<"delivery.submitted">;
  });
  owed.delete(messageId);
  if (owed.size === 0) unrecorded.delete(runtime);
  return recorded;
}

export function owesAcceptance(runtime: VaultRuntime, messageId: MessageId): boolean {
  return unrecorded.get(runtime)?.has(messageId) ?? false;
}

/** The acceptance of a package of `messageId` this runtime saw and has not recorded, recorded now; null when there is none. */
export async function recordOwedAcceptance(runtime: VaultRuntime, messageId: MessageId): Promise<VaultEvent<"delivery.submitted"> | null> {
  const packageId = unrecorded.get(runtime)?.get(messageId);
  return packageId === undefined ? null : recordAcceptance(runtime, messageId, packageId);
}
