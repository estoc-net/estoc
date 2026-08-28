import { connect, decode, encode, type Daemon, type DaemonEvents, type Port } from "@estoc/daemon";

/**
 * The daemon as this page reaches it. By default a dedicated worker,
 * alive as long as the tab, holding the vault in this origin's storage.
 * Or a process on this machine over a WebSocket, its vault a folder on
 * disk: either this very page was served by `estoc-daemon` (it marks its
 * index.html with a `<meta name="estoc-daemon">`, the socket is this
 * origin's, and the link it printed carries the token as `?token=`), or
 * the page was opened with `?_daemon=ws://…?token=…` from what the daemon
 * printed, a choice remembered here until `?_daemon=off`. The token is
 * the only key either way; a page without one is answered by nobody and
 * says so. Either way the UI holds this proxy and nothing else.
 */

const DAEMON_KEY = "estoc:daemon";
const TOKEN_KEY = "estoc:daemon-token";

/** Read (and strip) `?_daemon=` from the URL, remembering the choice; the remembered URL, if any. */
export function takeDaemonUrl(): string | null {
  const url = new URL(location.href);
  const given = url.searchParams.get("_daemon");
  if (given !== null) {
    url.searchParams.delete("_daemon");
    history.replaceState(null, "", url);
    try {
      if (given === "off" || given === "") {
        localStorage.removeItem(DAEMON_KEY);
      } else {
        localStorage.setItem(DAEMON_KEY, given);
      }
    } catch {
      // no storage: this page only
      return given === "off" || given === "" ? null : given;
    }
  }
  try {
    return localStorage.getItem(DAEMON_KEY);
  } catch {
    return null;
  }
}

export interface Started {
  daemon: Daemon;
  /** where the daemon is: in this page, or at a socket */
  where: "worker" | string;
}

/**
 * The socket of the daemon that served this page, if one did: this
 * origin's, with the token read (and stripped) from `?token=` and
 * remembered, so a reload or a second tab here gets in too.
 */
function servedByDaemon(): string | null {
  const meta = document.querySelector('meta[name="estoc-daemon"]');
  if (meta === null) {
    return null;
  }
  const url = new URL(location.href);
  let token = url.searchParams.get("token");
  if (token !== null) {
    url.searchParams.delete("token");
    history.replaceState(null, "", url);
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // no storage: this page only
    }
  } else {
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
  }
  const socket = new URL(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`);
  if (token !== null) {
    socket.searchParams.set("token", token);
  }
  return socket.href;
}

export function startDaemon(events: DaemonEvents): Started {
  const handlers = events as unknown as Record<string, (...args: never[]) => unknown>;
  const remote = servedByDaemon() ?? takeDaemonUrl();
  if (remote === null) {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return { daemon: connect<Daemon>(worker, handlers), where: "worker" };
  }
  const port = socketPort(remote, events);
  const daemon = connect<Daemon>(port, handlers);
  port.onReopen = () => void daemon.boot().catch(() => undefined);
  return { daemon, where: remote };
}

interface SocketPort extends Port {
  onReopen: (() => void) | null;
}

/**
 * A WebSocket as the message port the RPC speaks over, text-encoded, that
 * comes back by itself: when the socket drops, calls in flight fail, the
 * UI is told the daemon is unreachable, and the next open replays where
 * things stand (the daemon's `boot()` does that for a returning client).
 */
function socketPort(url: string, events: DaemonEvents): SocketPort {
  const listeners: { message: ((event: MessageEvent) => void)[]; close: (() => void)[] } = { message: [], close: [] };
  let ws: WebSocket | null = null;
  /** an open that follows a close — the first open included, when a connect failed before it — replays */
  let replayOnOpen = false;
  /** what was said while the socket was still connecting */
  let queued: string[] = [];
  const port: SocketPort = {
    onReopen: null,
    postMessage(message) {
      const text = encode(message);
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      } else if (ws !== null && ws.readyState === WebSocket.CONNECTING) {
        queued.push(text);
      } else {
        // fail the call now rather than hang it: the caller sees the daemon is away
        for (const l of listeners.close) {
          l();
        }
      }
    },
    addEventListener(type: "message" | "close", listener: (event: MessageEvent) => void) {
      if (type === "close") {
        listeners.close.push(listener as unknown as () => void);
      } else {
        listeners.message.push(listener);
      }
    },
  } as SocketPort;
  const open = () => {
    const socket = new WebSocket(url);
    ws = socket;
    socket.addEventListener("open", () => {
      for (const text of queued) {
        socket.send(text);
      }
      queued = [];
      if (replayOnOpen) {
        port.onReopen?.();
      }
      replayOnOpen = true;
    });
    socket.addEventListener("message", (event: MessageEvent<string>) => {
      const data = decode(event.data);
      for (const l of listeners.message) {
        l({ data } as MessageEvent);
      }
    });
    socket.addEventListener("close", () => {
      ws = null;
      queued = [];
      replayOnOpen = true;
      for (const l of listeners.close) {
        l();
      }
      events.status({ state: "error", detail: `daemon at ${new URL(url).host} is not answering` }, null);
      setTimeout(open, 2000);
    });
  };
  open();
  return port;
}
