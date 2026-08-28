import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

import type { Daemon } from "../api.js";
import { decode, encode } from "../codec.js";
import { createDaemon, type Emit } from "../daemon.js";
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
 * things stand. Access control: the socket is on loopback, but any page in
 * any browser on the machine can open one, so a page must either be one
 * this daemon served — the browser says so in `Origin`, which a page
 * cannot forge — or present the token; anything else is closed before a
 * word is read. With `appDir` the daemon serves the app itself, and the
 * page it serves needs no token at all.
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
  const http = createServer((req, res) => {
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
    if (!(files !== null && sameOrigin(req)) && !tokenMatches(req, options.token)) {
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
    appUrl: files === null ? null : `http://${hostPart}:${boundPort}/`,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

/** The upgrade comes from a page this server sent: its Origin is the host it was fetched from. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return typeof origin === "string" && typeof host === "string" && origin === `http://${host}`;
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
