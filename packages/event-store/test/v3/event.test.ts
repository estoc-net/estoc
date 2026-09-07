import { describe, expect, it } from "vitest";

import { drislCid, rawCid } from "@estoc/dasl";
import {
  InvalidEvent,
  MAX_T,
  atOf,
  canonicalEventBytes,
  compareEvents,
  isAuthorId,
  isCanonicalAt,
  isEventId,
  isRawCid,
  isUuidv7,
  matches,
  timestampOf,
  validateDraft,
  validateEvent,
  type AuthorId,
  type Cid,
  type Draft,
  type Event,
  type EventId,
  type JsonObject,
} from "../../src/v3/index.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cp = (...units: number[]) => String.fromCharCode(...units);

const base: Event = {
  eventId: "019b2a46-8b36-75c6-a74b-81a2aa5fb407" as EventId,
  at: "2026-09-03T15:04:05.123Z",
  author: "019b2a43-4a56-7c0f-862f-194c0c4124a0" as AuthorId,
  type: "contact.petname",
  roots: [],
  data: { contactId: "019b2a45-8381-793f-943c-f5d806fd5ca2", name: "Alice" },
};

// dasl-objects.md §4.2 vectors
const RAW_HELLO = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const RAW_EMPTY = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const DRISL_EMPTY_MAP = "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua";
const DAG_PB = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("identity", () => {
  it("knows a canonical lowercase UUIDv7", () => {
    expect(isUuidv7("0198f5f0-1234-7abc-8def-0123456789ab")).toBe(true);
    expect(isUuidv7("0198f5f0-1234-7abc-cdef-0123456789ab")).toBe(false); // variant
    expect(isUuidv7("0198f5f0-1234-4abc-8def-0123456789ab")).toBe(false); // v4
    expect(isUuidv7("0198F5F0-1234-7ABC-8DEF-0123456789AB")).toBe(false); // case
    expect(isUuidv7("0198f5f012347abc8def0123456789ab")).toBe(false); // no dashes
    expect(isUuidv7("urn:uuid:0198f5f0-1234-7abc-8def-0123456789ab")).toBe(false);
    expect(isUuidv7(7)).toBe(false);
    expect(isEventId(base.eventId)).toBe(true);
    expect(isAuthorId(base.author)).toBe(true);
  });

  it("reads the millisecond a UUIDv7 embeds", () => {
    expect(timestampOf("00000000-03e8-7000-8000-000000000000")).toBe(1000);
    expect(timestampOf("ffffffff-ffff-7fff-bfff-ffffffffffff")).toBe(2 ** 48 - 1);
    expect(timestampOf(base.eventId)).toBe(0x019b2a468b36);
    expect(() => timestampOf("nope")).toThrow(InvalidEvent);
  });

  it("accepts as a root only a canonical raw DASL CID (dasl-objects.md §3)", async () => {
    expect(await rawCid(new TextEncoder().encode("hello"))).toBe(RAW_HELLO);
    expect(await rawCid(new Uint8Array())).toBe(RAW_EMPTY);
    expect(await drislCid(new Uint8Array([0xa0]))).toBe(DRISL_EMPTY_MAP);
    expect(isRawCid(RAW_HELLO)).toBe(true);
    expect(isRawCid(RAW_EMPTY)).toBe(true);
    expect(isRawCid(DRISL_EMPTY_MAP)).toBe(false);
    expect(isRawCid(DAG_PB)).toBe(false);
    expect(isRawCid(RAW_HELLO.toUpperCase())).toBe(false);
    expect(isRawCid(`B${RAW_HELLO.slice(1)}`)).toBe(false);
    expect(isRawCid(RAW_HELLO.slice(0, -1))).toBe(false);
    expect(isRawCid(`${RAW_HELLO}a`)).toBe(false);
    expect(isRawCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(false); // CIDv0
    expect(isRawCid("")).toBe(false);
    expect(isRawCid(42)).toBe(false);
  });
});

describe("time (ES-17)", () => {
  it("accepts exactly YYYY-MM-DDTHH:mm:ss.sssZ naming a real UTC instant", () => {
    expect(isCanonicalAt("2026-08-30T10:00:00.123Z")).toBe(true);
    expect(isCanonicalAt("2024-02-29T00:00:00.000Z")).toBe(true);
    expect(isCanonicalAt("1970-01-01T00:00:00.000Z")).toBe(true);
    expect(isCanonicalAt("9999-12-31T23:59:59.999Z")).toBe(true);
    expect(isCanonicalAt("0001-01-01T00:00:00.000Z")).toBe(true);
    const bad = [
      "2026-08-30T10:00:00Z", // no fraction
      "2026-08-30T10:00:00.1Z",
      "2026-08-30T10:00:00.12Z",
      "2026-08-30T10:00:00.1234Z",
      "2026-08-30T10:00:00.123456Z",
      "2026-08-30T10:00:00.123456789Z",
      "2026-08-30T10:00:00.123+00:00",
      "2026-08-30T10:00:00.123",
      "2026-08-30t10:00:00.123z",
      "2026-08-30 10:00:00.123Z",
      "2026-08-30T10:00:60.123Z", // leap second spelling
      "2026-08-30T10:60:00.123Z",
      "2026-08-30T24:00:00.000Z",
      "2026-02-30T10:00:00.123Z",
      "2023-02-29T00:00:00.000Z",
      "2026-13-01T10:00:00.123Z",
      "2026-00-01T10:00:00.123Z",
      "2026-08-00T10:00:00.123Z",
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      " 2026-08-30T10:00:00.123Z",
      "2026-08-30T10:00:00.123Z\n",
    ];
    for (const value of bad) {
      expect(isCanonicalAt(value), value).toBe(false);
    }
    expect(isCanonicalAt(1756548000123)).toBe(false);
  });

  it("spells an integer millisecond one way, and lexical order is millisecond order", () => {
    expect(atOf(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(atOf(1756548000123)).toBe("2025-08-30T10:00:00.123Z");
    expect(atOf(MAX_T)).toBe("9999-12-31T23:59:59.999Z");
    expect(() => atOf(MAX_T + 1)).toThrow(RangeError);
    expect(() => atOf(-1)).toThrow(RangeError);
    expect(() => atOf(1000.5)).toThrow(RangeError);
    expect(() => atOf(NaN)).toThrow(RangeError);
    const samples = [0, 999, 1000, 1001, 86400000, 1756548000123, 1756548000124, 4102444800000, MAX_T];
    for (let i = 0; i < 200; i++) samples.push(Math.floor(Math.random() * MAX_T));
    const sorted = [...samples].sort((a, b) => a - b);
    const spelled = samples.map(atOf).sort();
    expect(spelled).toEqual(sorted.map(atOf));
    for (const t of samples) {
      expect(Date.parse(atOf(t))).toBe(t);
      expect(isCanonicalAt(atOf(t))).toBe(true);
    }
  });
});

describe("envelope validation (§3.4)", () => {
  it("returns the value, typed, when the eight rules hold", () => {
    expect(validateEvent(base)).toBe(base);
    expect(validateEvent({ ...base, roots: [RAW_HELLO], data: {} })).toBeDefined();
  });

  it("rejects every rule broken, naming the first", () => {
    const cases: [string, unknown, RegExp][] = [
      ["not an object", "event", /JSON object/],
      ["an array", [base], /JSON object/],
      ["null", null, /JSON object/],
      ["a class instance", Object.assign(Object.create({ x: 1 }), base), /JSON object/],
      ["missing data", omit(base, "data"), /missing data/],
      ["missing roots", omit(base, "roots"), /missing roots/],
      ["an unknown field", { ...base, extra: 1 }, /unknown top-level field "extra"/],
      ["v2 spelling", { ...omit(base, "eventId"), eid: base.eventId }, /missing eventId/],
      ["uppercase eventId", { ...base, eventId: base.eventId.toUpperCase() }, /eventId/],
      ["v4 eventId", { ...base, eventId: "0198f5f0-1234-4abc-8def-0123456789ab" }, /eventId/],
      ["at without fraction", { ...base, at: "2026-09-03T15:04:05Z" }, /at is not/],
      ["at with leap second", { ...base, at: "2026-09-03T15:04:60.000Z" }, /at is not/],
      ["at as a number", { ...base, at: 1756911845123 }, /at is not/],
      ["author not a UUIDv7", { ...base, author: "k7q3ma" }, /author/],
      ["empty type", { ...base, type: "" }, /type/],
      ["type not a string", { ...base, type: 1 }, /type/],
      ["roots not an array", { ...base, roots: null }, /roots is not an array/],
      ["roots as a string", { ...base, roots: RAW_HELLO }, /roots is not an array/],
      ["a drisl root", { ...base, roots: [DRISL_EMPTY_MAP] }, /not a canonical raw DASL CID/],
      ["a dag-pb root", { ...base, roots: [DAG_PB] }, /raw DASL CID/],
      ["an uppercase root", { ...base, roots: [RAW_HELLO.toUpperCase()] }, /raw DASL CID/],
      ["a non-string root", { ...base, roots: [1] }, /raw DASL CID/],
      ["data an array", { ...base, data: [] }, /data is not a JSON object/],
      ["data null", { ...base, data: null }, /data is not a JSON object/],
      ["data a string", { ...base, data: "x" }, /data is not a JSON object/],
      ["ES-4: undefined in data", { ...base, data: { a: undefined } }, /not I-JSON/],
      ["ES-4: NaN in data", { ...base, data: { a: NaN } }, /not I-JSON/],
      ["ES-4: Infinity in data", { ...base, data: { a: [Infinity] } }, /not I-JSON/],
      ["ES-4: a bigint in data", { ...base, data: { a: 1n } }, /not I-JSON/],
      ["ES-4: a lone surrogate in data", { ...base, data: { a: cp(0xd800) } }, /not I-JSON/],
      ["ES-4: a lone surrogate in a name", { ...base, data: { "\udc00": 1 } }, /not I-JSON/],
      ["ES-4: a Date in data", { ...base, data: { a: new Date(0) } }, /not I-JSON/],
      ["ES-4: a lone surrogate in type", { ...base, type: "\ud800" }, /not I-JSON/],
    ];
    for (const [what, value, message] of cases) {
      expect(() => validateEvent(value), what).toThrow(InvalidEvent);
      expect(() => validateEvent(value), what).toThrow(message);
    }
  });

  it("ES-21: checks eventId and at independently and never compares their timestamps", () => {
    // the UUID says 1000 ms after the epoch; `at` says 2026 — immutable history is not rejected for it
    const event = { ...base, eventId: "00000000-03e8-7000-8000-000000000000" };
    expect(timestampOf(event.eventId)).not.toBe(Date.parse(event.at));
    expect(validateEvent(event)).toBe(event);
  });

  it("validates a draft the same way and normalizes it into fresh data", () => {
    const data = { a: [1, { b: "x" }] };
    const draft = validateDraft({ type: "t", data });
    expect(draft).toEqual({ type: "t", roots: [], data });
    expect(draft.data).not.toBe(data);
    (draft.data.a as unknown[]).push(2);
    expect(draft.data.a).toHaveLength(3);
    expect(data.a).toHaveLength(2);
    const roots = [RAW_HELLO as Cid];
    const withRoots = validateDraft({ type: "t", roots, data: {} });
    expect(withRoots.roots).toEqual(roots);
    expect(withRoots.roots).not.toBe(roots);
    const bad: [string, unknown][] = [
      ["not an object", "t"],
      ["no type", { data: {} }],
      ["empty type", { type: "", data: {} }],
      ["no data", { type: "t" }],
      ["data an array", { type: "t", data: [] }],
      ["roots not an array", { type: "t", roots: RAW_HELLO, data: {} }],
      ["a drisl root", { type: "t", roots: [DRISL_EMPTY_MAP], data: {} }],
      ["ES-4: undefined member", { type: "t", data: { a: undefined } }],
      ["ES-4: lone surrogate", { type: "t", data: { a: "\ude02" } }],
      ["r1-A: noncharacter", { type: "t", data: { a: cp(0xfdd0) } }],
      ["r1-B: lone surrogate in type", { type: cp(0xd800), data: {} }],
      ["r1-B: noncharacter in type", { type: `t${cp(0xffff)}`, data: {} }],
    ];
    for (const [what, value] of bad) {
      expect(() => validateDraft(value), what).toThrow(InvalidEvent);
    }
  });

  it("r1-B: a draft it accepts makes an event validateEvent accepts, to the last level of nesting", () => {
    const wrapped = (levels: number) => {
      let data: JsonObject = {};
      for (let i = 0; i < levels; i++) data = { x: data };
      return data;
    };
    const complete = (draft: Required<Draft>): Event => ({
      eventId: base.eventId,
      at: base.at,
      author: base.author,
      ...draft,
    });
    // root object + data + 998 wrappers = 1000 containers deep: the limit, allowed
    const deepest = validateDraft({ type: "t", data: wrapped(998) });
    expect(() => validateEvent(complete(deepest))).not.toThrow();
    // one more is over the limit for the event, so the draft is refused too
    expect(() => validateDraft({ type: "t", data: wrapped(999) })).toThrow(/deeper/);
    expect(() => validateEvent(complete({ type: "t", roots: [], data: wrapped(999) }))).toThrow(/deeper/);
    for (const draft of [{ type: "t", data: {} }, { type: "a.b", roots: [RAW_HELLO as Cid], data: { n: [1, { s: "😂" }] } }]) {
      expect(() => validateEvent(complete(validateDraft(draft)))).not.toThrow();
    }
  });
});

describe("canonical bytes and order", () => {
  it("ES-5/ES-6: content equality is byte equality of the RFC 8785 form, whatever the member order", () => {
    const reordered: Event = {
      data: { name: "Alice", contactId: base.data.contactId as string },
      roots: [],
      type: base.type,
      author: base.author,
      at: base.at,
      eventId: base.eventId,
    };
    expect(text(canonicalEventBytes(base))).toBe(
      '{"at":"2026-09-03T15:04:05.123Z","author":"019b2a43-4a56-7c0f-862f-194c0c4124a0",' +
        '"data":{"contactId":"019b2a45-8381-793f-943c-f5d806fd5ca2","name":"Alice"},' +
        '"eventId":"019b2a46-8b36-75c6-a74b-81a2aa5fb407","roots":[],"type":"contact.petname"}'
    );
    expect(canonicalEventBytes(reordered)).toEqual(canonicalEventBytes(base));
    const other: Event = { ...base, data: { ...base.data, name: "Alicia" } };
    expect(canonicalEventBytes(other)).not.toEqual(canonicalEventBytes(base));
    const laterAt: Event = { ...base, at: "2026-09-03T15:04:05.124Z" };
    expect(canonicalEventBytes(laterAt)).not.toEqual(canonicalEventBytes(base));
  });

  it("orders by at, then eventId, then author (§4.3)", () => {
    const e = (at: string, eventId: string, author: string): Event => ({
      ...base,
      at,
      eventId: eventId as EventId,
      author: author as AuthorId,
    });
    const a = e("2026-01-01T00:00:00.000Z", "019b2a46-8b36-75c6-a74b-81a2aa5fb407", "019b2a43-4a56-7c0f-862f-194c0c4124a0");
    const b = e("2026-01-01T00:00:00.001Z", "019b2a46-0000-7000-8000-000000000000", "019b2a43-0000-7000-8000-000000000000");
    const c = e("2026-01-01T00:00:00.001Z", "019b2a46-0000-7000-8000-000000000001", "019b2a43-0000-7000-8000-000000000000");
    const d = e("2026-01-01T00:00:00.001Z", "019b2a46-0000-7000-8000-000000000001", "019b2a43-0000-7000-8000-000000000001");
    expect([d, c, b, a].sort(compareEvents)).toEqual([a, b, c, d]);
    expect(compareEvents(a, a)).toBe(0);
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(d, c)).toBeGreaterThan(0);
  });

  it("filters by equality on author, type and top-level data fields (§5.4)", () => {
    const event: Event = { ...base, data: { n: 1, s: "x", z: null, o: { k: 1 }, a: [1], f: false } };
    expect(matches(event)).toBe(true);
    expect(matches(event, {})).toBe(true);
    expect(matches(event, { author: base.author })).toBe(true);
    expect(matches(event, { author: "019b2a43-0000-7000-8000-000000000000" as AuthorId })).toBe(false);
    expect(matches(event, { type: "contact.petname" })).toBe(true);
    expect(matches(event, { type: "contact" })).toBe(false);
    expect(matches(event, { data: { n: 1 } })).toBe(true);
    expect(matches(event, { data: { n: 1.0 } })).toBe(true);
    expect(matches(event, { data: { n: "1" } })).toBe(false);
    expect(matches(event, { data: { s: "x", f: false } })).toBe(true);
    expect(matches(event, { data: { z: null } })).toBe(true);
    expect(matches(event, { data: { missing: null } })).toBe(false);
    expect(matches(event, { data: { missing: undefined } })).toBe(true);
    expect(matches(event, { data: { o: null } })).toBe(false);
    expect(matches(event, { data: { a: 1 } })).toBe(false);
    expect(matches(event, { type: "contact.petname", data: { n: 2 } })).toBe(false);
  });
});

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...(value as Record<string, unknown>) };
  delete copy[key as string];
  return copy as Omit<T, K>;
}
