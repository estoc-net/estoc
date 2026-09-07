/**
 * The UUIDv7 allocator of event-store.md §4.2: one clock sample gives
 * both `eventId` and `at`; within a millisecond, a counter in the
 * leftmost random bits keeps mint order; when the counter would
 * overflow, allocation fails before anything is minted — the timestamp
 * is never moved forward to make room, and the counter never wraps.
 *
 * Layout (RFC 9562 §5.7 with a §6.2 counter spanning `rand_a` and the
 * top of `rand_b`):
 *
 *     unix_ts_ms  48 bits   the sampled integer millisecond `t`
 *     ver          4 bits   0111
 *     rand_a      12 bits   counter, high 12 bits
 *     var          2 bits   10
 *     rand_b      62 bits   counter, low 30 bits; then 32 random bits
 *
 * The counter is 42 bits wide. On the first mint at a millisecond it is
 * seeded at random with its top bit clear (RFC 9562 §6.2 "counter
 * rollover guard"), so at least 2^41 IDs fit in any millisecond. Each
 * later mint at the same millisecond — the same `append`, the next
 * `append`, an `appendAll` of any size — continues the counter.
 *
 * Clock rollback (§4.2): a smaller sample is used as it comes, for both
 * fields. To avoid a collision when rollback revisits a millisecond this
 * runtime already minted in, the allocator remembers the last counter of
 * the most recent `REMEMBERED` milliseconds and continues from it; a
 * millisecond older than that is reseeded at random, as a restart would.
 * Mint order is promised only between samples without rollback (§4.2).
 */

import { CounterExhausted } from "./errors.js";
import { atOf, type EventId } from "./event.js";

export interface Uuidv7AllocatorOptions {
  /** The clock: Unix milliseconds, fractional allowed, truncated to the integer (§4.2). Default `Date.now`. */
  now?: () => number;
  /** Fills `bytes` with randomness. Default `crypto.getRandomValues`. */
  random?: (bytes: Uint8Array) => void;
  /**
   * Counter width in bits, 1–42; default 42. A test narrows it to reach
   * exhaustion; a product has no reason to.
   */
  counterBits?: number;
}

/** What one mint gives: the sample `t`, its `at`, and the IDs in mint order, all embedding `t`. */
export interface Minted {
  t: number;
  at: string;
  eventIds: EventId[];
}

/** Milliseconds whose last counter is kept for rollback revisits. */
export const REMEMBERED = 4096;

const RANDOM_BITS = 74n;
const MAX_T = 2 ** 48 - 1;

export class Uuidv7Allocator {
  readonly counterBits: number;
  private readonly now: () => number;
  private readonly random: (bytes: Uint8Array) => void;
  /** millisecond → last counter minted at it, oldest first */
  private readonly recent = new Map<number, number>();
  private readonly tail = new Uint8Array(16);

  constructor(options: Uuidv7AllocatorOptions = {}) {
    const bits = options.counterBits ?? 42;
    if (!Number.isInteger(bits) || bits < 1 || bits > 42) throw new RangeError(`counterBits ${String(bits)} is not 1–42`);
    this.counterBits = bits;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((bytes) => crypto.getRandomValues(bytes));
  }

  /** One ID and its `at`: `mint(1)`. */
  mintOne(): { eventId: EventId; at: string } {
    const { eventIds, at } = this.mint(1);
    return { eventId: eventIds[0] as EventId, at };
  }

  /**
   * `n` IDs from one clock sample, in mint order (§5.2). Throws
   * `CounterExhausted`, having minted nothing, when they do not fit in
   * the sampled millisecond. `mint(0)` samples nothing and mints nothing.
   */
  mint(n: number): Minted {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`cannot mint ${String(n)} IDs`);
    const t = Math.floor(this.now());
    if (!Number.isInteger(t) || t < 0 || t > MAX_T) throw new RangeError(`clock reading ${String(t)} is not a 48-bit millisecond`);
    const at = atOf(t);
    if (n === 0) return { t, at, eventIds: [] };
    const limit = 2 ** this.counterBits;
    const last = this.recent.get(t);
    const first = last === undefined ? this.seed() : last + 1;
    const room = limit - first;
    if (n > room) throw new CounterExhausted(t, n, Math.max(room, 0));
    const eventIds: EventId[] = [];
    for (let i = 0; i < n; i++) eventIds.push(this.format(t, first + i));
    this.recent.delete(t);
    this.recent.set(t, first + n - 1);
    while (this.recent.size > REMEMBERED) this.recent.delete(this.recent.keys().next().value as number);
    return { t, at, eventIds };
  }

  /** A random counter start with the top bit clear: at least half the space ahead. */
  private seed(): number {
    const bytes = new Uint8Array(6);
    this.random(bytes);
    let value = 0;
    for (const byte of bytes) value = value * 256 + byte;
    return value % 2 ** (this.counterBits - 1);
  }

  private format(t: number, counter: number): EventId {
    this.random(this.tail);
    let random = 0n;
    for (const byte of this.tail) random = (random << 8n) | BigInt(byte);
    const free = RANDOM_BITS - BigInt(this.counterBits);
    const r = (BigInt(counter) << free) | (random & ((1n << free) - 1n));
    const randA = r >> 62n;
    const randB = r & ((1n << 62n) - 1n);
    const uuid = (BigInt(t) << 80n) | (7n << 76n) | (randA << 64n) | (2n << 62n) | randB;
    const hex = uuid.toString(16).padStart(32, "0");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as EventId;
  }
}
