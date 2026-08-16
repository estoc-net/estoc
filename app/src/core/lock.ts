/**
 * One agent per vault at a time. Two tabs of this origin share the same
 * OPFS directory; two agents would append to the same log and both hold
 * live delivery. The Web Locks API arbitrates: the first tab takes the
 * vault lock and keeps it until it closes; a second tab sees that and
 * waits its turn rather than opening a second agent. Nothing is stolen —
 * closing the first tab is what hands the vault over.
 */

const LOCK = "estoc:vault";

const forever = () => new Promise<never>(() => undefined);

/**
 * Resolves once this tab holds the vault lock. `onWaiting` fires if
 * another tab has it, so the UI can say so while this one queues.
 */
export async function acquireVaultLock(onWaiting: () => void): Promise<void> {
  if (!("locks" in navigator) || typeof navigator.locks?.request !== "function") {
    // No Web Locks (an old browser): run, and hope for one tab.
    return;
  }
  await new Promise<void>((resolve) => {
    void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
      if (lock !== null) {
        resolve();
        await forever();
        return;
      }
      onWaiting();
      void navigator.locks.request(LOCK, async () => {
        resolve();
        await forever();
      });
    });
  });
}
