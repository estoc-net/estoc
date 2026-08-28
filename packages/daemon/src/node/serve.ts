import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import type { Daemon } from "../api.js";
import { decode, encode } from "../codec.js";
import { createDaemon, type Emit } from "../daemon.js";
import type { DaemonHost } from "../host.js";
import { serve, type Port } from "../rpc.js";

export interface ServeOptions {
  host: DaemonHost;
  /** the loopback address to listen on; never 0.0.0.0 by default */
  bind?: string;
  port: number;
  /** what a client must present as `?token=` to be answered at all */
  token: string;
}

export interface Served {
  daemon: Daemon;
  /** the URL a UI connects to, token included */
  url: string;
  close(): Promise<void>;
}

/**
 * The daemon behind a WebSocket: one daemon, any number of UIs. Each
 * socket is a port the RPC serves; events go to every socket open; a UI
 * that connects late calls `boot()` like any other and is told where
 * things stand. The token is the whole access control — the socket is on
 * loopback, but any page in any browser on the machine can open one, and
 * a page without the token is closed before a word is read.
 */
export async function serveDaemon(options: ServeOptions): Promise<Served> {
  const emitters = new Set<Emit>();
  const emit: Emit = (name, ...args) => {
    for (const e of emitters) {
      e(name, ...args);
    }
  };
  const daemon = createDaemon(options.host, emit);

  const http = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" }).end("estoc-daemon: connect over WebSocket\n");
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (!tokenMatches(req, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const port = socketPort(ws);
      const e = serve(port, daemon);
      emitters.add(e);
      ws.on("close", () => emitters.delete(e));
    });
  });

  const bind = options.bind ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, bind, () => resolve());
  });
  const address = http.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  const hostPart = bind.includes(":") ? `[${bind}]` : bind;
  return {
    daemon,
    url: `ws://${hostPart}:${boundPort}/?token=${encodeURIComponent(options.token)}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => http.close(() => resolve()));
      }),
  };
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
