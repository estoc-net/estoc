import { describe, expect, it } from "vitest";

import {
  EidMinter,
  InvalidEvent,
  atKey,
  compareEvents,
  isDeviceId,
  isRfc3339Utc,
  isUuidv7,
  jsonClean,
  mintDeviceId,
  mintInstance,
  sameJson,
  validateEvent,
  type Event,
} from "../src/index.js";

const base: Event = {
  eid: "0198f5f0-0000-7000-8000-000000000000",
  at: "2026-08-30T10:00:00Z",
  author: "k7q3ma",
  type: "t",
  blobs: [],
  data: {},
};

describe("identity and time", () => {
  it("knows a uuidv7, a device id and RFC 3339 UTC", () => {
    expect(isUuidv7("0198f5f0-1234-7abc-8def-0123456789ab")).toBe(true);
    expect(isUuidv7("0198f5f0-1234-7abc-cdef-0123456789ab")).toBe(false); // variant
    expect(isUuidv7("0198f5f0-1234-4abc-8def-0123456789ab")).toBe(false); // v4
    expect(isUuidv7("0198F5F0-1234-7ABC-8DEF-0123456789AB")).toBe(false); // case
    expect(isUuidv7(7)).toBe(false);
    expect(isDeviceId("k7q3ma")).toBe(true);
    expect(isDeviceId("k7q3m")).toBe(false);
    expect(isDeviceId("K7Q3MA")).toBe(false);
    expect(isDeviceId("k7q3m1")).toBe(false); // 0, 1, 8, 9 are not base32
    for (let i = 0; i < 50; i++) {
      expect(isDeviceId(mintDeviceId())).toBe(true);
    }
    expect(mintInstance()).not.toBe(mintInstance());
    expect(isRfc3339Utc("2026-08-30T10:00:00Z")).toBe(true);
    expect(isRfc3339Utc("2026-08-30T10:00:00.123Z")).toBe(true);
    expect(isRfc3339Utc("2026-08-30T10:00:00.123456789Z")).toBe(true);
    expect(isRfc3339Utc("2026-08-30T10:00:00.1234567890Z")).toBe(false);
    expect(isRfc3339Utc("2026-08-30T10:00:00+00:00")).toBe(false);
    expect(isRfc3339Utc("2026-08-30t10:00:00z")).toBe(false);
    expect(isRfc3339Utc("2026-08-30T10:00:00")).toBe(false);
    expect(isRfc3339Utc("2026-02-30T10:00:00Z")).toBe(false);
    expect(isRfc3339Utc("2026-13-01T10:00:00Z")).toBe(false);
    expect(isRfc3339Utc("2026-08-30T24:00:00Z")).toBe(false);
    expect(isRfc3339Utc("2024-02-29T00:00:00Z")).toBe(true);
    expect(isRfc3339Utc("2023-02-29T00:00:00Z")).toBe(false);
    expect(isRfc3339Utc(new Date().toISOString())).toBe(true);
  });

  it("orders by at, then eid, then author, with one instant one key whatever its spelling", () => {
    expect(atKey("2026-08-30T10:00:00Z")).toBe("2026-08-30T10:00:00.000000000Z");
    expect(atKey("2026-08-30T10:00:00.5Z")).toBe("2026-08-30T10:00:00.500000000Z");
    const a = { ...base, at: "2026-08-30T10:00:00.000Z", eid: "0198f5f0-0000-7000-8000-000000000002" };
    const b = { ...base, at: "2026-08-30T10:00:00Z", eid: "0198f5f0-0000-7000-8000-000000000001" };
    expect(compareEvents(a, b)).toBe(1); // same instant: b's eid is smaller
    expect(compareEvents(b, a)).toBe(-1);
    expect(compareEvents({ ...a, at: "2026-08-30T09:59:59.999Z" }, b)).toBe(-1);
    expect(compareEvents({ ...a, at: "2026-08-30T10:00:00.0000001Z" }, b)).toBe(1);
    expect(compareEvents({ ...b, author: "aaaaaa" }, { ...b, author: "bbbbbb" })).toBe(-1);
    expect(compareEvents(b, { ...b })).toBe(0);
  });

  it("mints monotone ids through a stalled or backward clock", () => {
    const minter = new EidMinter();
    const t = Date.parse("2026-08-30T10:00:00Z");
    const ids = [minter.mint(t), minter.mint(t), minter.mint(t), minter.mint(t - 5000), minter.mint(t + 1)];
    for (let i = 1; i < ids.length; i++) {
      expect(isUuidv7(ids[i])).toBe(true);
      expect((ids[i] as string) > (ids[i - 1] as string)).toBe(true);
    }
    expect((ids[0] as string).slice(0, 8)).toBe((ids[3] as string).slice(0, 8)); // the stalled ms, not the earlier one
  });
});

describe("validation", () => {
  it("accepts the six fields and nothing else", () => {
    expect(validateEvent(base)).toBe(base);
    expect(() => validateEvent({ ...base, extra: 1 })).toThrow(InvalidEvent);
    expect(() => validateEvent({ ...base, extra: 1 })).toThrow(/"extra"/);
    const { data: _data, ...noData } = base;
    expect(() => validateEvent(noData)).toThrow(/data/);
    const { blobs: _blobs, ...noBlobs } = base;
    expect(() => validateEvent(noBlobs)).toThrow(/blobs/);
    expect(() => validateEvent({ ...base, blobs: ["x"] })).toThrow(/blobs/);
    expect(() => validateEvent({ ...base, data: null })).toThrow(/data/);
    expect(() => validateEvent("nope")).toThrow(InvalidEvent);
  });
});

describe("JSON", () => {
  it("compares structurally, key order aside", () => {
    expect(sameJson({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameJson([1, 2], [2, 1])).toBe(false);
    expect(sameJson({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameJson(null, {})).toBe(false);
    expect(sameJson(1, 1.0)).toBe(true);
    expect(sameJson("é", "é")).toBe(false); // code points, not normalized
  });

  it("cleans what survives serialization and rejects what does not", () => {
    const value = { a: 1, b: [true, null, "s"], c: { d: {} } };
    const clean = jsonClean(value);
    expect(clean).toEqual(value);
    expect(clean).not.toBe(value);
    expect(() => jsonClean({ a: undefined })).toThrow();
    expect(() => jsonClean({ a: new Date() })).toThrow();
    expect(() => jsonClean({ a: NaN })).toThrow();
    expect(() => jsonClean({ a: 1n })).toThrow();
    expect(() => jsonClean(undefined)).toThrow();
    expect(() => jsonClean(() => 1)).toThrow();
    expect(() => jsonClean(new Map([["a", 1]]))).toThrow(); // serializes as {}
    const cyclic: Record<string, unknown> = {};
    cyclic["me"] = cyclic;
    expect(() => jsonClean(cyclic)).toThrow();
  });
});
