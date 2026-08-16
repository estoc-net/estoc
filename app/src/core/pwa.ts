import { registerSW } from "virtual:pwa-register";

/**
 * The installable half: the service worker that keeps the app shell (and
 * the didcomm WASM) available offline, and the browser's install prompt.
 * Updates wait for a nod — a chat mid-sentence should not reload under
 * anyone; the vault is on disk either way, but the moment is theirs.
 */

export interface PwaHooks {
  onUpdateReady(apply: () => void): void;
  onOfflineReady(): void;
  onInstallable(prompt: () => Promise<void>): void;
}

export function setupPwa(hooks: PwaHooks): void {
  const update = registerSW({
    onNeedRefresh() {
      hooks.onUpdateReady(() => void update(true));
    },
    onOfflineReady() {
      hooks.onOfflineReady();
    },
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    const deferred = event as Event & { prompt(): Promise<void> };
    hooks.onInstallable(() => deferred.prompt());
  });
}

/** Running as an installed app (home screen / desktop window) rather than a tab. */
export function isInstalled(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as { standalone?: boolean }).standalone === true
  );
}
