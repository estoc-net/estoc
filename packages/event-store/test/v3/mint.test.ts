import { afterEach, describe, expect, it, vi } from "vitest";

import { atOf, isUuidv7, mint, timestampOf } from "../../src/v3/index.js";

/** A clock the test moves by hand. */
function clock(start: number) {
  let t = start;
  return { now: () => t, set: (value: number) => (t = value) };
}

function ascending(ids: string[]): boolean {
  return ids.every((id, i) => i === 0 || (ids[i - 1] as string) < id);
}

describe("mint", () => {
  afterEach(() => vi.useRealTimers());

  it("more than 4096 IDs from one mint are distinct canonical UUIDv7; that they sort in mint order, later mints after them, is `uuid`'s doing, not the profile's", () => {
    const c = clock(1756548000123);
    const batch = mint(5000, c.now);
    expect(batch.t).toBe(1756548000123);
    expect(batch.at).toBe("2025-08-30T10:00:00.123Z");
    expect(batch.eventIds).toHaveLength(5000);
    expect(new Set(batch.eventIds).size).toBe(5000);
    expect(ascending(batch.eventIds)).toBe(true);
    for (const id of batch.eventIds) expect(isUuidv7(id)).toBe(true);
    // `uuid` continues its counter across separate mints under the same clock reading
    const one = mint(1, c.now);
    const two = mint(1, c.now);
    expect(one.at).toBe(batch.at);
    expect(ascending([...batch.eventIds, ...one.eventIds, ...two.eventIds])).toBe(true);
    // and the next millisecond sorts after all of them
    c.set(1756548000124);
    const later = mint(3, c.now);
    expect(later.at).toBe("2025-08-30T10:00:00.124Z");
    expect(ascending([...two.eventIds, ...later.eventIds])).toBe(true);
  });

  it("`at` is the clock it is given; the ID's embedded time is the generator's own reading of the wall clock", () => {
    const before = Date.now();
    const { t, at, eventIds } = mint(2, () => 1000.999);
    const after = Date.now();
    expect(t).toBe(1000);
    expect(at).toBe(atOf(1000));
    for (const id of eventIds) {
      expect(timestampOf(id)).toBeGreaterThanOrEqual(before);
      expect(timestampOf(id)).toBeLessThanOrEqual(after);
    }
    // nothing ties the two: an `at` far from the generator's clock is still an `at`
    expect(mint(1, () => 0).at).toBe("1970-01-01T00:00:00.000Z");
  });

  it("after the store's clock rolls back, `at` follows it, every ID is still distinct and a batch shares one `at`", () => {
    const c = clock(1000);
    const first = mint(1, c.now);
    c.set(999);
    const back = mint(3, c.now);
    expect(back.t).toBe(999);
    expect(back.at).toBe(atOf(999));
    c.set(1000);
    const again = mint(1, c.now);
    expect(again.at).toBe(atOf(1000));
    const all = [...first.eventIds, ...back.eventIds, ...again.eventIds];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(isUuidv7(id)).toBe(true);
  });

  it("refuses a count that is not one and a clock it cannot spell; mint(0) reads the clock and mints nothing", () => {
    expect(() => mint(-1)).toThrow(RangeError);
    expect(() => mint(1.5)).toThrow(RangeError);
    expect(() => mint(1, () => -1)).toThrow(RangeError);
    expect(() => mint(1, () => NaN)).toThrow(RangeError);
    // beyond the year 9999 there is no canonical `at`, so no event
    expect(() => mint(1, () => 253402300800000)).toThrow(RangeError);
    expect(mint(0, () => 1000)).toEqual({ t: 1000, at: atOf(1000), eventIds: [] });
  });

  // Last: it leaves the module instance's generator timestamp in the future.
  it("when the wall clock itself rolls back, the generator still mints distinct IDs without following it — and, being `uuid`, still in mint order", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = Date.UTC(2100, 0, 1);
    vi.setSystemTime(t);
    const ahead = mint(2);
    expect(ahead.at).toBe(atOf(t));
    vi.setSystemTime(t - 5);
    const behind = mint(2);
    // `at` reports the clock as read
    expect(behind.at).toBe(atOf(t - 5));
    // the IDs are the generator's business: distinct, still ascending, and the embedded
    // timestamp held where it was rather than moving back (RFC 9562 §6.2, as `uuid` does it)
    const all = [...ahead.eventIds, ...behind.eventIds];
    expect(new Set(all).size).toBe(4);
    expect(ascending(all)).toBe(true);
    for (const id of behind.eventIds) expect(timestampOf(id)).toBeGreaterThanOrEqual(t);
  });
});
