/**
 * Minting for a local append (event-store.md §4.2, §5.1–5.2): `at` is
 * one reading of the wall clock, spelled canonically; `eventId` is what
 * the `uuid` package's standard RFC 9562 UUIDv7 generator gives. The
 * profile asks nothing of that generator beyond RFC 9562: its
 * counter, what it does when the counter is full and what it does when
 * the clock moves backwards are its own. `uuid`'s `v7()`, called without
 * options, keeps state in its own module instance — a counter seeded at
 * random on each new millisecond and an embedded timestamp that never
 * moves backwards — so IDs from one instance of the module compare in
 * mint order. That is `uuid`'s property, which the tests record; the
 * profile neither requires nor promises it: a batch is returned in
 * input order, and canonical order is §4.3's.
 *
 * `at` and the UUID's `unix_ts_ms` are two observations of the wall
 * clock: usually the same millisecond, never required to be. `at` comes
 * from `now`, injectable so a store can be tested; the generator reads
 * `Date.now` itself.
 */

import { v7 } from "uuid";

import { atOf, type EventId } from "./event.js";

/** What one mint gives: the clock reading `t`, its canonical `at`, and the fresh IDs in mint order. */
export interface Minted {
  t: number;
  at: string;
  eventIds: EventId[];
}

/**
 * `n` fresh event IDs and the one `at` they share, for one append or
 * batch. `now` is Unix milliseconds, fractional allowed, truncated to
 * the integer (§4.2); default `Date.now`. Throws `RangeError`, having
 * minted nothing, on an `n` that is not a count or a clock reading
 * `atOf` cannot spell. `mint(0)` reads the clock and mints no ID;
 * whether an empty batch reads the clock at all is the store's rule
 * (§5.2), not this one's.
 */
export function mint(n: number, now: () => number = Date.now): Minted {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`cannot mint ${String(n)} IDs`);
  const t = Math.floor(now());
  const at = atOf(t);
  const eventIds: EventId[] = [];
  for (let i = 0; i < n; i++) eventIds.push(v7() as EventId);
  return { t, at, eventIds };
}
