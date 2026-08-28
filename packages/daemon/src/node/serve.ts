import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import type { Daemon } from "../api.js";
import { decode, encode } from "../codec.js";
import { createDaemon, type DaemonCore, type Emit } from "../daemon.js";
import type { DaemonHost } from "../host.js";
import { serve, type Port } from "../rpc.js";
import { staticHandler } from "./static.js";

export interface ServeOptions {
  host: DaemonHost;
  /** the loopback address to listen on; never 0.0.0.0 by default */
  bind?: string;
  port: number;
  /** what a client must present as `?token=` to be answered at all */
  token: string;
  /** a directory of the built app to serve at `/`; without it plain HTTP gets a 426 */
  appDir?: string;
}

export interface Served {
  daemon: Daemon;
  /** the URL a UI connects to, token included */
  url: string;
  /** where the app is served, when `appDir` was given */
  appUrl: string | null;
  close(): Promise<void>;
}

/**
 * The daemon behind a WebSocket: one daemon, any number of UIs. Each
 * socket is a port the RPC serves; events go to every socket open; a UI
 * that connects late calls `boot()` like any other and is told where
 * things stand. Access control is one rule: a socket is answered only
 * with the token (`?token=`), whoever asks — a page this daemon served,
 * a page elsewhere, another process on this machine; anything without it
 * is closed before a word is read. With `appDir` the daemon serves the
 * app itself, and hands the page the token in the link it prints.
 *
 * On top of that a request is answered only when `Host` is a name this
 * server actually answers to: a loopback name, the bound address, or
 * (bound to every interface) an address of this machine — all at the
 * bound port. A page anywhere can point a name of its own at 127.0.0.1
 * (DNS rebinding) and reach us; it gets nothing, socket or file.
 */
export async function serveDaemon(options: ServeOptions): Promise<Served> {
  const emitters = new Set<Emit>();
  const emit: Emit = (name, ...args) => {
    for (const e of emitters) {
      e(name, ...args);
    }
  };
  const daemon = createDaemon(options.host, emit);

  const files = options.appDir === undefined ? null : staticHandler(options.appDir);
  const bind = options.bind ?? "127.0.0.1";
  let boundPort = options.port;
  const hostAllowed = (req: IncomingMessage) => hostIsOurs(req.headers.host, bind, boundPort);
  const http = createServer((req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(421, { "content-type": "text/plain" }).end("estoc-daemon: not a host of mine\n");
      return;
    }
    if (files === null) {
      res.writeHead(426, { "content-type": "text/plain" }).end("estoc-daemon: connect over WebSocket\n");
      return;
    }
    files(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (!hostAllowed(req) || !tokenMatches(req, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const port = socketPort(ws);
      const client = clientOf(daemon, port, emitters);
      ws.on("close", client.gone);
    });
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, bind, () => resolve());
  });
  const address = http.address();
  boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const hostPart = bind.includes(":") ? `[${bind}]` : bind;
  return {
    daemon,
    url: `ws://${hostPart}:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    appUrl: files === null ? null : `http://${hostPart}:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

/**
 * One socket's view of the daemon. Calls go to the daemon; its `boot()`,
 * once the daemon is up, is a replay to this socket alone. While that
 * replay reads the snapshot, live events for this socket wait, and follow
 * the snapshot out — so nothing the snapshot did not yet hold is shown
 * and then overwritten by it. (What the snapshot does hold may come again
 * as an event; the UI takes records by id.)
 */
function clientOf(daemon: DaemonCore, port: Port, emitters: Set<Emit>): { gone(): void } {
  let held: unknown[][] | null = null;
  // the UI's interface only: what is the host's stays here
  const { booted: _booted, replayTo: _replayTo, ...methods } = daemon;
  const raw = serve(port, {
    ...methods,
    async boot() {
      if (!daemon.booted) {
        await daemon.boot();
        return;
      }
      held = [];
      try {
        await daemon.replayTo(raw);
      } finally {
        const queue = held;
        held = null;
        for (const [name, ...args] of queue) {
          raw(name as string, ...args);
        }
      }
    },
  } satisfies Daemon);
  const gated: Emit = (name, ...args) => {
    if (held !== null) {
      held.push([name, ...args]);
    } else {
      raw(name, ...args);
    }
  };
  emitters.add(gated);
  return { gone: () => emitters.delete(gated) };
}

/** `Host` names this server: a loopback name, the bound address, or any address of this machine when bound to all — at the bound port. */
function hostIsOurs(header: string | undefined, bind: string, port: number): boolean {
  if (header === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return false;
  }
  if (Number(url.port || "80") !== port) {
    return false;
  }
  const name = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (name === "localhost" || name === "127.0.0.1" || name === "::1" || name === "::ffff:127.0.0.1") {
    return true;
  }
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === "";
  if (!wildcard) {
    return name === bind.toLowerCase();
  }
  return Object.values(networkInterfaces()).some((addrs) => addrs?.some((a) => a.address.toLowerCase() === name));
}

function tokenMatches(req: IncomingMessage, token: string): boolean {
  const given = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A ws socket as the message port the RPC speaks over, text-encoded. */
function socketPort(ws: WebSocket): Port {
  return {
    postMessage(message) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encode(message));
      }
    },
    addEventListener(type: "message" | "close", listener: (event: MessageEvent) => void) {
      if (type === "close") {
        ws.on("close", () => (listener as () => void)());
        return;
      }
      ws.on("message", (data) => {
        listener({ data: decode(data.toString()) } as MessageEvent);
      });
    },
  } as Port;
}
