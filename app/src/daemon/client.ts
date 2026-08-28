import type { Daemon, DaemonEvents } from "./api.js";
import { connect } from "./rpc.js";

/**
 * The daemon as this page reaches it: a dedicated worker, alive as long as
 * the tab. The worker holds the vault lock, the unlocked seed and the
 * agent; the UI holds this proxy.
 */
export function startDaemon(events: DaemonEvents): Daemon {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return connect<Daemon>(worker, events as unknown as Record<string, (...args: never[]) => unknown>);
}
