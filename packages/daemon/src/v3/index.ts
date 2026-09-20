/**
 * `@estoc/daemon/v3` — the daemon over the version-3 vault: one SQLite
 * file the host owns, the agent of `@estoc/agent-core/v3` over it, and
 * the vault handed to a UI as records. The RPC and its text encoding
 * are the package root's.
 */

export type { ContactSummary, CreatedInvitation, Daemon, DaemonEvents, Lines, LocalDidSummary, MediationSummary, Merged, Outcome, Phase, SendResult, Snapshot } from "./api.js";
export { VAULT_FILE, type DaemonHost, type DaemonStorage } from "./host.js";
export { RESTORE_EXPLAINED, createDaemon, type DaemonCore, type Emit } from "./daemon.js";
export { connect, serve, type Port } from "../rpc.js";
export { decode, encode } from "../codec.js";
