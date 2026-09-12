import { expect } from "vitest";

import type { AuthorId, Event, EventId } from "../../../src/v3/index.js";

export { ANCHOR, META, WRAPPED, REWRAPPED } from "../fixtures.js";


/** A clock in Unix milliseconds the test moves by hand. */
export function clock(start: string): { now: () => number; advance: (ms: number) => void; set: (iso: string) => void } {
  let t = new Date(start).getTime();
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (iso) => {
      t = new Date(iso).getTime();
    },
  };
}

export async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

export function ids(events: Event[]): string[] {
  return events.map((event) => event.eventId);
}

/**
 * A canonical UUIDv7 whose embedded timestamp is `t` and whose random
 * bits are `seed`, spelled out: the tests' way of naming an author, or
 * an event whose ID says one time while its `at` says another.
 */
export function uuidv7At(t: number, seed: number): string {
  const ts = t.toString(16).padStart(12, "0");
  const s = (seed >>> 0).toString(16).padStart(8, "0");
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${s.slice(0, 3)}-8${s.slice(3, 6)}-${s.slice(6, 8)}${s}${s.slice(0, 2)}`;
}

/** The n-th of the tests' authors: distinct, canonical, and readable in a failure. */
export function authorN(n: number): AuthorId {
  return uuidv7At(1_700_000_000_000 + n, 0x0a0a0a00 + n) as AuthorId;
}

/** A deterministic shuffle: the same seed, the same order, whatever the runner. */
export function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** `items` cut into `sizes.length` runs of the given sizes (the last takes the rest). */
export function partition<T>(items: T[], sizes: number[]): T[][] {
  const out: T[][] = [];
  let at = 0;
  for (const [i, size] of sizes.entries()) {
    const end = i === sizes.length - 1 ? items.length : at + size;
    out.push(items.slice(at, end));
    at = end;
  }
  return out;
}

/** An event as another serialization would carry it: members in another order, through JSON text and back. */
export function reordered(event: Event): unknown {
  const data = Object.fromEntries(Object.entries(event.data).reverse());
  return JSON.parse(JSON.stringify({ data, roots: [...event.roots], type: event.type, author: event.author, at: event.at, eventId: event.eventId }));
}

/** `event` with one field of `data` changed: same `eventId`, other content. */
export function altered(event: Event): Event {
  return { ...event, data: { ...event.data, altered: true } };
}

/** `event` under another `eventId`, everything else the same. */
export function renamed(event: Event, eventId: string): Event {
  return { ...event, eventId: eventId as EventId };
}

/**
 * `expect(actual).toEqual(expected)` for bytes. vitest's deep equality walks
 * a typed array element by element — over a second for 100 KiB, more than
 * CI's timeout for a MiB — where a byte compare is instant; and a mismatch
 * names the first byte that differs, which the diff of a MiB never would.
 * `message` goes to both assertions, as `expect`'s own would.
 */
export function expectBytes(actual: Uint8Array | null | undefined, expected: Uint8Array, message?: string): void {
  expect(actual, message).toBeInstanceOf(Uint8Array);
  const got = actual as Uint8Array;
  expect(got.length, `${message ? `${message}: ` : ""}byte length`).toBe(expected.length);
  let at = 0;
  while (at < got.length && got[at] === expected[at]) at += 1;
  expect(at, `${message ? `${message}: ` : ""}bytes differ at offset ${at}: ${got[at]} here, ${expected[at]} expected`).toBe(got.length);
}
