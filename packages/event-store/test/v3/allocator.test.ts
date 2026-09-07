import { describe, expect, it } from "vitest";

import { CounterExhausted, REMEMBERED, Uuidv7Allocator, atOf, isUuidv7, timestampOf } from "../../src/v3/index.js";

/** A clock the test moves by hand. */
function clock(start: number) {
  let t = start;
  return { now: () => t, set: (value: number) => (t = value) };
}

const zeros = (bytes: Uint8Array) => bytes.fill(0);
const ones = (bytes: Uint8Array) => bytes.fill(0xff);

function ascending(ids: string[]): boolean {
  return ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id);
}

describe("Uuidv7Allocator", () => {
  it("ES-19: more than 4096 IDs from one sample are distinct, embed that sample and sort in input order", () => {
    const c = clock(1756548000123);
    const allocator = new Uuidv7Allocator({ now: c.now });
    const batch = allocator.mint(5000);
    expect(batch.t).toBe(1756548000123);
    expect(batch.at).toBe("2025-08-30T10:00:00.123Z");
    expect(batch.eventIds).toHaveLength(5000);
    expect(new Set(batch.eventIds).size).toBe(5000);
    expect(ascending(batch.eventIds)).toBe(true);
    for (const id of batch.eventIds) {
      expect(isUuidv7(id)).toBe(true);
      expect(timestampOf(id)).toBe(1756548000123);
    }
    // back-to-back separate mints with the same sample continue in mint order
    const one = allocator.mintOne();
    const two = allocator.mintOne();
    expect(one.at).toBe(batch.at);
    expect(ascending([...batch.eventIds, one.eventId, two.eventId])).toBe(true);
    // and the next millisecond sorts after all of them
    c.set(1756548000124);
    const later = allocator.mint(3);
    expect(later.at).toBe("2025-08-30T10:00:00.124Z");
    expect(ascending([two.eventId, ...later.eventIds])).toBe(true);
  });

  it("lays the counter out across rand_a and the top of rand_b", () => {
    const allocator = new Uuidv7Allocator({ now: () => 1000, random: zeros });
    const { eventIds } = allocator.mint(3);
    expect(eventIds).toEqual([
      "00000000-03e8-7000-8000-000000000000",
      "00000000-03e8-7000-8000-000100000000",
      "00000000-03e8-7000-8000-000200000000",
    ]);
    // counter 2^30 carries out of rand_b's 30 bits into rand_a: seed at 2^30 - 1, zero tail
    const seeded = (bytes: Uint8Array) => (bytes.length === 6 ? bytes.set([0, 0, 0x3f, 0xff, 0xff, 0xff]) : bytes.fill(0));
    const wide = new Uuidv7Allocator({ now: () => 1000, random: seeded });
    expect(wide.mint(2).eventIds).toEqual(["00000000-03e8-7000-bfff-ffff00000000", "00000000-03e8-7001-8000-000000000000"]);
  });

  it("seeds each new millisecond at random with the counter's top bit clear, and fills the tail at random", () => {
    const allocator = new Uuidv7Allocator({ now: () => 1000, random: ones });
    expect(allocator.mintOne().eventId).toBe("00000000-03e8-77ff-bfff-ffffffffffff");
    const real = new Uuidv7Allocator({ now: () => 1000 });
    const a = real.mintOne().eventId;
    const b = new Uuidv7Allocator({ now: () => 1000 }).mintOne().eventId;
    expect(a).not.toBe(b);
    expect(timestampOf(a)).toBe(1000);
    expect(a.slice(14, 15)).toBe("7");
    expect("89ab").toContain(a.slice(19, 20));
  });

  it("ES-22: counter exhaustion fails before anything is minted, wraps nothing and moves no timestamp", () => {
    const c = clock(1000);
    const allocator = new Uuidv7Allocator({ now: c.now, random: zeros, counterBits: 3 });
    // seed 0 with 3 bits: exactly 8 IDs fit in a millisecond
    expect(() => allocator.mint(9)).toThrow(CounterExhausted);
    const eight = allocator.mint(8).eventIds;
    expect(eight).toHaveLength(8);
    expect(ascending(eight)).toBe(true);
    expect(eight[0]).toBe("00000000-03e8-7000-8000-000000000000");
    expect(eight[7]).toBe("00000000-03e8-7e00-8000-000000000000");
    let caught: unknown;
    try {
      allocator.mintOne();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CounterExhausted);
    expect(caught).toMatchObject({ t: 1000, requested: 1, room: 0 });
    // the failure did not advance the sample on its own: the same clock still fails
    expect(() => allocator.mint(1)).toThrow(CounterExhausted);
    // and did not wrap: nothing at t=1000 was minted twice
    expect(new Set(eight).size).toBe(8);
    // mint(0) asks for nothing and touches nothing
    expect(allocator.mint(0)).toEqual({ t: 1000, at: atOf(1000), eventIds: [] });
    // a new sample has room again
    c.set(1001);
    const next = allocator.mintOne();
    expect(timestampOf(next.eventId)).toBe(1001);
    expect(next.at).toBe(atOf(1001));
    // partial room: a batch that does not fit leaves the counter where it was
    c.set(1002);
    allocator.mint(5); // 0..4 of 8
    expect(() => allocator.mint(4)).toThrow(CounterExhausted);
    const rest = allocator.mint(3).eventIds; // 5..7
    expect(rest[0]).toBe("00000000-03ea-7a00-8000-000000000000");
  });

  it("ES-20: after clock rollback the smaller sample is used for both fields, with no collision on a revisit", () => {
    const c = clock(1000);
    const allocator = new Uuidv7Allocator({ now: c.now, random: zeros });
    const first = allocator.mintOne();
    c.set(999);
    const back = allocator.mint(2);
    expect(back.t).toBe(999);
    expect(back.at).toBe(atOf(999));
    for (const id of back.eventIds) expect(timestampOf(id)).toBe(999);
    c.set(1000);
    const again = allocator.mintOne();
    expect(again.at).toBe(atOf(1000));
    expect(timestampOf(again.eventId)).toBe(1000);
    // deterministic randomness would have reseeded to the same counter: the remembered
    // millisecond continues instead, so the revisit collides with nothing
    expect(again.eventId).not.toBe(first.eventId);
    expect(again.eventId > first.eventId).toBe(true);
    const all = [first.eventId, ...back.eventIds, again.eventId];
    expect(new Set(all).size).toBe(all.length);
    // no order promise spans the rollback: 999's IDs sort before 1000's although minted later
    expect(ascending(all)).toBe(false);
  });

  it("forgets a millisecond older than the last REMEMBERED and reseeds it like a restart would", () => {
    const c = clock(1000);
    const allocator = new Uuidv7Allocator({ now: c.now, random: zeros });
    const first = allocator.mintOne().eventId;
    for (let i = 1; i < REMEMBERED; i++) {
      c.set(1000 + i);
      allocator.mintOne();
    }
    c.set(1000);
    expect(allocator.mintOne().eventId).not.toBe(first); // still remembered: continues, and counts as recent again
    for (let i = REMEMBERED; i < 2 * REMEMBERED; i++) {
      c.set(1000 + i);
      allocator.mintOne();
    }
    c.set(1000);
    expect(allocator.mintOne().eventId).toBe(first); // forgotten: reseeded from the (all-zero) randomness
  });

  it("truncates a fractional clock and refuses one it cannot embed", () => {
    expect(new Uuidv7Allocator({ now: () => 1000.999 }).mint(1).t).toBe(1000);
    expect(new Uuidv7Allocator({ now: () => 1000.999 }).mint(1).at).toBe(atOf(1000));
    expect(() => new Uuidv7Allocator({ now: () => -1 }).mint(1)).toThrow(RangeError);
    expect(() => new Uuidv7Allocator({ now: () => NaN }).mint(1)).toThrow(RangeError);
    expect(() => new Uuidv7Allocator({ now: () => 2 ** 48 }).mint(1)).toThrow(RangeError);
    // beyond the year 9999 there is no canonical `at`, so no event
    expect(() => new Uuidv7Allocator({ now: () => 253402300800000 }).mint(1)).toThrow(RangeError);
    expect(() => new Uuidv7Allocator({ counterBits: 0 })).toThrow(RangeError);
    expect(() => new Uuidv7Allocator({ counterBits: 43 })).toThrow(RangeError);
    expect(() => new Uuidv7Allocator().mint(-1)).toThrow(RangeError);
    expect(() => new Uuidv7Allocator().mint(1.5)).toThrow(RangeError);
  });
});
