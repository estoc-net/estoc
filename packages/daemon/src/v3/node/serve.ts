import { serveOver, type ServedOver, type SocketOptions } from "../../node/socket.js";
import type { Daemon } from "../api.js";
import { createDaemon } from "../daemon.js";
import type { DaemonHost } from "../host.js";

export interface ServeOptions extends SocketOptions {
  host: DaemonHost;
}

export type Served = ServedOver<Daemon>;

/** The daemon behind a WebSocket, under the rules of `serveOver`: one daemon, any number of UIs, each answered only with the token. */
export function serveDaemon(options: ServeOptions): Promise<Served> {
  return serveOver(options, (emit) => createDaemon(options.host, emit));
}
