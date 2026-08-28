import { connect, decode, encode, type Daemon, type DaemonEvents, type Port } from "@estoc/daemon";

/**
 * The daemon as this page reaches it. By default a dedicated worker,
 * alive as long as the tab, holding the vault in this origin's storage.
 * Or — when the page was opened with `?_daemon=ws://…` from what
 * `estoc-daemon` printed — a process on this machine over a WebSocket,
 * its vault a folder on disk; the choice is remembered here until
 * `?_daemon=off`. Either way the UI holds this proxy and nothing else.
 */

const DAEMON_KEY = "estoc:daemon";

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

export function startDaemon(events: DaemonEvents): Started {
  const handlers = events as unknown as Record<string, (...args: never[]) => unknown>;
  const remote = takeDaemonUrl();
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
  let everOpened = false;
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
      if (everOpened) {
        port.onReopen?.();
      }
      everOpened = true;
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
