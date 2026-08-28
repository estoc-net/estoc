/**
 * Calls and events over a message port, both ways typed by the interfaces
 * in api.ts. A call is a method name and its arguments; the reply is the
 * value or the error's message. An event is a name and its arguments.
 * Everything rides structured clone, so records, byte arrays and Maps
 * cross as they are — a CryptoKey could too, which is exactly why the
 * daemon never puts one on the wire.
 */

export interface Port {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  /** a port that can go away (a socket) says so, and every call in flight fails */
  addEventListener(type: "close", listener: () => void): void;
}

type Wire =
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; message: string }
  | { kind: "event"; name: string; args: unknown[] };

type Handlers = Record<string, (...args: never[]) => unknown>;

/** Answer calls on `port` from `target`'s methods; returns the way to raise events. */
export function serve(port: Port, target: object): (name: string, ...args: unknown[]) => void {
  port.addEventListener("message", (event: MessageEvent<Wire>) => {
    const wire = event.data;
    if (wire.kind !== "call") {
      return;
    }
    const method = (target as Record<string, unknown>)[wire.method];
    void (async () => {
      try {
        if (typeof method !== "function") {
          throw new Error(`no such method: ${wire.method}`);
        }
        const value: unknown = await (method as (...args: unknown[]) => unknown).apply(target, wire.args);
        port.postMessage({ kind: "result", id: wire.id, value } satisfies Wire);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        port.postMessage({ kind: "error", id: wire.id, message } satisfies Wire);
      }
    })();
  });
  return (name, ...args) => port.postMessage({ kind: "event", name, args } satisfies Wire);
}

/** A proxy whose every method is a call over `port`; events land on `events` by name. */
export function connect<T extends object>(port: Port, events: Handlers): T {
  let next = 1;
  const pending = new Map<number, { resolve(value: unknown): void; reject(err: Error): void }>();
  port.addEventListener("message", (event: MessageEvent<Wire>) => {
    const wire = event.data;
    if (wire.kind === "event") {
      (events[wire.name] as ((...args: unknown[]) => void) | undefined)?.(...wire.args);
      return;
    }
    if (wire.kind !== "result" && wire.kind !== "error") {
      return;
    }
    const call = pending.get(wire.id);
    if (call === undefined) {
      return;
    }
    pending.delete(wire.id);
    if (wire.kind === "result") {
      call.resolve(wire.value);
    } else {
      call.reject(new Error(wire.message));
    }
  });
  port.addEventListener("close", () => {
    for (const [id, call] of pending) {
      pending.delete(id);
      call.reject(new Error("the daemon went away"));
    }
  });
  return new Proxy({} as T, {
    get(_, method) {
      if (typeof method !== "string") {
        return undefined;
      }
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          // an omitted optional argument is not sent: a text transport
          // would turn it into null, which is not the same absence
          while (args.length > 0 && args[args.length - 1] === undefined) {
            args.pop();
          }
          port.postMessage({ kind: "call", id, method, args } satisfies Wire);
        });
    },
  });
}
