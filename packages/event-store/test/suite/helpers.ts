import { expect } from "vitest";

import type { Event } from "../../src/index.js";

/** A clock the test moves by hand. */
export function clock(start: string): { now: () => Date; advance: (ms: number) => void; set: (iso: string) => void } {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
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
  for await (const item of items) {
    out.push(item);
  }
  return out;
}

export function eids(events: Event[]): string[] {
  return events.map((event) => event.eid);
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

/** An event as a backup might carry it: a fresh object, keys in another order, so that identity is content. */
export function reordered(event: Event): unknown {
  const data = Object.fromEntries(Object.entries(event.data).reverse());
  return { data, blobs: [...event.blobs], type: event.type, author: event.author, at: event.at, eid: event.eid };
}

/** `event` with one field of `data` changed: same eid, other content. */
export function altered(event: Event): Event {
  return { ...event, data: { ...event.data, altered: true } };
}

/**
 * `expect(actual).toEqual(expected)` for bytes. vitest's deep equality walks
 * a typed array element by element — over a second for a MiB — where a byte
 * compare is instant; and a mismatch names the first byte that differs, which
 * the diff of a MiB never would.
 */
export function expectBytes(actual: Uint8Array | null | undefined, expected: Uint8Array): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  const got = actual as Uint8Array;
  expect(got.length, "byte length").toBe(expected.length);
  let at = 0;
  while (at < got.length && got[at] === expected[at]) {
    at += 1;
  }
  expect(at, `bytes differ at offset ${at}: ${got[at]} here, ${expected[at]} expected`).toBe(got.length);
}
