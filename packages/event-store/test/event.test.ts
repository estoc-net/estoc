import { describe, expect, it, test } from "vitest";

import { drislCid, rawCid } from "@estoc/dasl";
import {
  InvalidEvent,
  MAX_T,
  atOf,
  canonicalEventBytes,
  canonicalEventText,
  compareEvents,
  envelopeOf,
  eventCidOf,
  isAuthorId,
  isCanonicalAt,
  isEventCid,
  isRawCid,
  isUuidv7,
  matches,
  sampleAt,
  validateDraft,
  validateEnvelope,
  validateEvent,
  type AuthorId,
  type Cid,
  type Draft,
  type Event,
  type EventCid,
  type EventEnvelope,
  type JsonObject,
} from "../src/index.js";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const cp = (...units: number[]) => String.fromCharCode(...units);

const envelope: EventEnvelope = {
  at: "2026-09-03T15:04:05.123Z",
  author: "019b2a43-4a56-7c0f-862f-194c0c4124a0" as AuthorId,
  type: "contact.petname",
  roots: [],
  data: { contactId: "019b2a45-8381-793f-943c-f5d806fd5ca2", name: "Alice" },
};
const base: Event = { ...envelope, cid: eventCidOf(envelope) };

// the specification's worked example
const EXAMPLE: EventEnvelope = {
  at: "2026-09-25T00:00:00.000Z",
  author: "019b0000-0000-7000-8000-000000000001" as AuthorId,
  type: "example.note",
  roots: [],
  data: { text: "hello" },
};
const EXAMPLE_CID = "bafkreigwmldn6qzody7iex3vwompw3zkdqihb5jzbpp3npvdod6rdnt5zi";

// the raw DASL CID vectors
const RAW_HELLO = "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq";
const RAW_EMPTY = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const DRISL_EMPTY_MAP = "bafyreigbtj4x7ip5legnfznufuopl4sg4knzc2cof6duas4b3q2fy6swua";
const DAG_PB = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("identity", () => {
  it("knows a canonical lowercase UUIDv7, which names an author", () => {
    expect(isUuidv7("0198f5f0-1234-7abc-8def-0123456789ab")).toBe(true);
    expect(isUuidv7("0198f5f0-1234-7abc-cdef-0123456789ab")).toBe(false); // variant
    expect(isUuidv7("0198f5f0-1234-4abc-8def-0123456789ab")).toBe(false); // v4
    expect(isUuidv7("0198F5F0-1234-7ABC-8DEF-0123456789AB")).toBe(false); // case
    expect(isUuidv7("0198f5f012347abc8def0123456789ab")).toBe(false); // no dashes
    expect(isUuidv7("urn:uuid:0198f5f0-1234-7abc-8def-0123456789ab")).toBe(false);
    expect(isUuidv7(7)).toBe(false);
    expect(isAuthorId(base.author)).toBe(true);
    expect(isEventCid(base.author)).toBe(false);
  });

  test("an event's CID is the raw DASL CID of its five-field canonical bytes: the specification's example, and nothing else in it", async () => {
    expect(eventCidOf(EXAMPLE)).toBe(EXAMPLE_CID);
    expect(await rawCid(canonicalEventBytes(EXAMPLE))).toBe(EXAMPLE_CID);
    expect(canonicalEventText(EXAMPLE)).toBe('{"at":"2026-09-25T00:00:00.000Z","author":"019b0000-0000-7000-8000-000000000001","data":{"text":"hello"},"roots":[],"type":"example.note"}');
    expect(isEventCid(EXAMPLE_CID)).toBe(true);
    // member order and whitespace change nothing; a value does; the CID is not among the bytes
    const shuffled = JSON.parse('{ "type": "example.note", "data": { "text": "hello" }, "roots": [], "author": "019b0000-0000-7000-8000-000000000001", "at": "2026-09-25T00:00:00.000Z" }') as EventEnvelope;
    expect(eventCidOf(shuffled)).toBe(EXAMPLE_CID);
    expect(eventCidOf({ ...EXAMPLE, data: { text: "hello!" } })).not.toBe(EXAMPLE_CID);
    expect(eventCidOf({ ...EXAMPLE, at: "2026-09-25T00:00:00.001Z" })).not.toBe(EXAMPLE_CID);
    expect(eventCidOf({ ...EXAMPLE, cid: EXAMPLE_CID } as EventEnvelope)).toBe(EXAMPLE_CID);
    expect(text(canonicalEventBytes({ ...EXAMPLE, cid: EXAMPLE_CID } as EventEnvelope))).not.toContain(EXAMPLE_CID);
    expect(envelopeOf({ ...EXAMPLE, cid: EXAMPLE_CID } as EventEnvelope)).toEqual(EXAMPLE);
  });

  it("accepts as a root only a canonical raw DASL CID", async () => {
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

describe("time", () => {
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

  it("samples the clock once, truncating to the millisecond, and refuses a reading it cannot spell", () => {
    expect(sampleAt(() => 1756548000123.9)).toEqual({ t: 1756548000123, at: "2025-08-30T10:00:00.123Z" });
    expect(sampleAt(() => 0)).toEqual({ t: 0, at: "1970-01-01T00:00:00.000Z" });
    expect(() => sampleAt(() => -1)).toThrow(RangeError);
    expect(() => sampleAt(() => MAX_T + 1)).toThrow(RangeError);
    expect(() => sampleAt(() => NaN)).toThrow(RangeError);
    expect(() => sampleAt(() => {
      throw new Error("no clock");
    })).toThrow("no clock");
    const { t, at } = sampleAt();
    expect(isCanonicalAt(at)).toBe(true);
    expect(Math.abs(t - Date.now())).toBeLessThan(5000);
  });
});

describe("envelope validation", () => {
  it("returns the envelope as data of its own when its rules hold, and the event with its CID checked", () => {
    const checked = validateEnvelope(envelope);
    expect(checked).toEqual(envelope);
    expect(checked).not.toBe(envelope);
    expect(checked.data).not.toBe(envelope.data);
    expect(validateEnvelope({ ...envelope, roots: [RAW_HELLO], data: {} })).toBeDefined();
    const event = validateEvent(base);
    expect(event).toEqual(base);
    expect(event).not.toBe(base);
    expect(event.data).not.toBe(base.data);
    expect(validateEvent({ ...EXAMPLE, cid: EXAMPLE_CID })).toEqual({ ...EXAMPLE, cid: EXAMPLE_CID });
  });

  it("rejects every rule broken, naming the first", () => {
    const cases: [string, unknown, RegExp][] = [
      ["not an object", "event", /JSON object/],
      ["an array", [envelope], /JSON object/],
      ["null", null, /JSON object/],
      ["a class instance", Object.assign(Object.create({ x: 1 }), envelope), /JSON object/],
      ["missing data", omit(envelope, "data"), /missing data/],
      ["missing roots", omit(envelope, "roots"), /missing roots/],
      ["an unknown field", { ...envelope, extra: 1 }, /unknown top-level field "extra"/],
      ["a cid among the envelope fields", base, /unknown top-level field "cid"/],
      ["an eventId", { ...envelope, eventId: "019b2a46-8b36-75c6-a74b-81a2aa5fb407" }, /unknown top-level field "eventId"/],
      ["at without fraction", { ...envelope, at: "2026-09-03T15:04:05Z" }, /at is not/],
      ["at with leap second", { ...envelope, at: "2026-09-03T15:04:60.000Z" }, /at is not/],
      ["at as a number", { ...envelope, at: 1756911845123 }, /at is not/],
      ["author not a UUIDv7", { ...envelope, author: "k7q3ma" }, /author/],
      ["uppercase author", { ...envelope, author: envelope.author.toUpperCase() }, /author/],
      ["empty type", { ...envelope, type: "" }, /type/],
      ["type not a string", { ...envelope, type: 1 }, /type/],
      ["roots not an array", { ...envelope, roots: null }, /roots is not an array/],
      ["roots as a string", { ...envelope, roots: RAW_HELLO }, /roots is not an array/],
      ["a drisl root", { ...envelope, roots: [DRISL_EMPTY_MAP] }, /not a canonical raw DASL CID/],
      ["a dag-pb root", { ...envelope, roots: [DAG_PB] }, /raw DASL CID/],
      ["an uppercase root", { ...envelope, roots: [RAW_HELLO.toUpperCase()] }, /raw DASL CID/],
      ["a non-string root", { ...envelope, roots: [1] }, /raw DASL CID/],
      ["data an array", { ...envelope, data: [] }, /data is not a JSON object/],
      ["data null", { ...envelope, data: null }, /data is not a JSON object/],
      ["data a string", { ...envelope, data: "x" }, /data is not a JSON object/],
      ["undefined in data", { ...envelope, data: { a: undefined } }, /not I-JSON/],
      ["NaN in data", { ...envelope, data: { a: NaN } }, /not I-JSON/],
      ["Infinity in data", { ...envelope, data: { a: [Infinity] } }, /not I-JSON/],
      ["a bigint in data", { ...envelope, data: { a: 1n } }, /not I-JSON/],
      ["a lone surrogate in data", { ...envelope, data: { a: cp(0xd800) } }, /not I-JSON/],
      ["a lone surrogate in a name", { ...envelope, data: { "\udc00": 1 } }, /not I-JSON/],
      ["a Date in data", { ...envelope, data: { a: new Date(0) } }, /not I-JSON/],
      ["a lone surrogate in type", { ...envelope, type: "\ud800" }, /not I-JSON/],
    ];
    for (const [what, value, message] of cases) {
      expect(() => validateEnvelope(value), what).toThrow(InvalidEvent);
      expect(() => validateEnvelope(value), what).toThrow(message);
    }
  });

  test("an API event has the five fields and cid, exactly, and the cid is the envelope's own", () => {
    const other = eventCidOf({ ...envelope, data: { ...envelope.data, name: "Alicia" } });
    const cases: [string, unknown, RegExp][] = [
      ["no cid", envelope, /missing cid/],
      ["an eventId beside the cid", { ...base, eventId: "019b2a46-8b36-75c6-a74b-81a2aa5fb407" }, /unknown top-level field "eventId"/],
      ["cid not a CID", { ...base, cid: "019b2a46-8b36-75c6-a74b-81a2aa5fb407" }, /cid is not a canonical raw DASL CID/],
      ["cid uppercase", { ...base, cid: base.cid.toUpperCase() }, /cid is not a canonical raw DASL CID/],
      ["cid a drisl CID", { ...base, cid: DRISL_EMPTY_MAP }, /cid is not a canonical raw DASL CID/],
      ["cid of other bytes", { ...base, cid: RAW_HELLO }, /is not the envelope's/],
      ["cid of another envelope", { ...base, cid: other }, /is not the envelope's/],
      ["the envelope changed under its cid", { ...base, data: { ...base.data, name: "Alicia" } }, /is not the envelope's/],
      ["cid null", { ...base, cid: null }, /cid is not a canonical raw DASL CID/],
      ["a broken envelope with a cid", { ...base, at: "2026-09-03T15:04:05Z" }, /at is not/],
    ];
    for (const [what, value, message] of cases) {
      expect(() => validateEvent(value), what).toThrow(InvalidEvent);
      expect(() => validateEvent(value), what).toThrow(message);
    }
    expect(validateEvent({ ...base, data: { ...base.data, name: "Alicia" }, cid: other })).toEqual({ ...base, data: { ...base.data, name: "Alicia" }, cid: other });
  });

  it("reads each member once: an accessor that answers differently later cannot change the envelope that was checked", () => {
    const once = <T>(first: T, later: unknown): (() => unknown) => {
      let reads = 0;
      return () => (++reads === 1 ? first : later);
    };
    const type = once("t", "");
    const root = once(RAW_HELLO, "not a cid");
    const x = once("ok", new Date(0));
    const roots = Object.defineProperty([] as unknown[], 0, { get: root, enumerable: true, configurable: true });
    roots.length = 1;
    const shifting = {
      ...envelope,
      get type() {
        return type();
      },
      roots,
      data: {
        get x() {
          return x();
        },
      },
    };
    const checked = validateEnvelope(shifting);
    expect(checked).toEqual({ ...envelope, type: "t", roots: [RAW_HELLO], data: { x: "ok" } });
    expect(text(canonicalEventBytes(checked))).toBe(JSON.stringify({ at: envelope.at, author: envelope.author, data: { x: "ok" }, roots: [RAW_HELLO], type: "t" }));
  });

  test("roots are the elements the array holds by index, whatever its iterator yields", () => {
    const silent = (elements: unknown[]): unknown[] => Object.defineProperty(elements.slice(), Symbol.iterator, { value: function* () {} });
    expect(validateEnvelope({ ...envelope, roots: silent([RAW_HELLO]) }).roots).toEqual([RAW_HELLO]);
    expect(validateDraft({ type: "t", roots: silent([RAW_HELLO]), data: {} }).roots).toEqual([RAW_HELLO]);
    for (const elements of [[undefined], ["not a cid"], new Array(1)]) {
      expect(() => validateEnvelope({ ...envelope, roots: silent(elements) })).toThrow(/roots: .* is not a canonical raw DASL CID/);
      expect(() => validateDraft({ type: "t", roots: silent(elements), data: {} })).toThrow(InvalidEvent);
    }
  });

  it("checks author and at independently and never compares the author's UUID time with at", () => {
    // the author's UUID says 1000 ms after the epoch; `at` says 2026 — immutable history is not rejected for it
    const old = { ...envelope, author: "00000000-03e8-7000-8000-000000000000" as AuthorId };
    expect(validateEnvelope(old)).toEqual(old);
    expect(validateEvent({ ...old, cid: eventCidOf(old) })).toEqual({ ...old, cid: eventCidOf(old) });
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
      ["undefined member", { type: "t", data: { a: undefined } }],
      ["lone surrogate", { type: "t", data: { a: "\ude02" } }],
      ["noncharacter", { type: "t", data: { a: cp(0xfdd0) } }],
      ["lone surrogate in type", { type: cp(0xd800), data: {} }],
      ["noncharacter in type", { type: `t${cp(0xffff)}`, data: {} }],
      ["cid supplied", { type: "t", data: {}, cid: RAW_HELLO }],
      ["at supplied", { type: "t", data: {}, at: "2026-09-07T10:00:00.000Z" }],
      ["author supplied", { type: "t", data: {}, author: "019b2a43-4a56-7c0f-862f-194c0c4124a0" }],
      ["cid supplied as undefined", { type: "t", data: {}, cid: undefined }],
      ["an eventId supplied", { type: "t", data: {}, eventId: "019b2a43-4a56-7c0f-862f-194c0c4124a0" }],
      ["any other field", { type: "t", data: {}, note: "x" }],
    ];
    for (const [what, value] of bad) {
      expect(() => validateDraft(value), what).toThrow(InvalidEvent);
    }
  });

  test("a draft it accepts makes an envelope validateEnvelope accepts, to the last level of nesting", () => {
    const wrapped = (levels: number) => {
      let data: JsonObject = {};
      for (let i = 0; i < levels; i++) data = { x: data };
      return data;
    };
    const complete = (draft: Required<Draft>): EventEnvelope => ({ at: envelope.at, author: envelope.author, ...draft });
    // root object + data + 998 wrappers = 1000 containers deep: the limit, allowed
    const deepest = validateDraft({ type: "t", data: wrapped(998) });
    expect(() => validateEnvelope(complete(deepest))).not.toThrow();
    expect(() => eventCidOf(complete(deepest))).not.toThrow();
    // one more is over the limit for the envelope, so the draft is refused too
    expect(() => validateDraft({ type: "t", data: wrapped(999) })).toThrow(/deeper/);
    expect(() => validateEnvelope(complete({ type: "t", roots: [], data: wrapped(999) }))).toThrow(/deeper/);
    for (const draft of [{ type: "t", data: {} }, { type: "a.b", roots: [RAW_HELLO as Cid], data: { n: [1, { s: "😂" }] } }]) {
      const made = complete(validateDraft(draft));
      expect(() => validateEvent({ ...made, cid: eventCidOf(made) })).not.toThrow();
    }
  });
});

describe("canonical bytes and order", () => {
  test("content equality is byte equality of the RFC 8785 form of the five fields, whatever the member order", () => {
    const reordered: EventEnvelope = {
      data: { name: "Alice", contactId: envelope.data.contactId as string },
      roots: [],
      type: envelope.type,
      author: envelope.author,
      at: envelope.at,
    };
    expect(text(canonicalEventBytes(envelope))).toBe(
      '{"at":"2026-09-03T15:04:05.123Z","author":"019b2a43-4a56-7c0f-862f-194c0c4124a0",' +
        '"data":{"contactId":"019b2a45-8381-793f-943c-f5d806fd5ca2","name":"Alice"},' +
        '"roots":[],"type":"contact.petname"}'
    );
    expect(canonicalEventBytes(reordered)).toEqual(canonicalEventBytes(envelope));
    expect(canonicalEventBytes(base)).toEqual(canonicalEventBytes(envelope));
    expect(eventCidOf(reordered)).toBe(base.cid);
    const other: EventEnvelope = { ...envelope, data: { ...envelope.data, name: "Alicia" } };
    expect(canonicalEventBytes(other)).not.toEqual(canonicalEventBytes(envelope));
    expect(eventCidOf(other)).not.toBe(base.cid);
    const laterAt: EventEnvelope = { ...envelope, at: "2026-09-03T15:04:05.124Z" };
    expect(canonicalEventBytes(laterAt)).not.toEqual(canonicalEventBytes(envelope));
  });

  it("orders by at, then the CID's text", () => {
    const e = (at: string, cid: string): Event => ({ ...base, at, cid: cid as EventCid });
    const a = e("2026-01-01T00:00:00.000Z", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    const b = e("2026-01-01T00:00:00.001Z", "bafkreib2jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    const c = e("2026-01-01T00:00:00.001Z", "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
    const d = e("2026-01-01T00:00:00.001Z", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect([d, c, b, a].sort(compareEvents)).toEqual([a, b, c, d]);
    expect(compareEvents(a, a)).toBe(0);
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(d, c)).toBeGreaterThan(0);
    // the text order — "2" before "m", as ASCII has it — is not the decoded bytes' order, where the digit is the larger value
    expect(compareEvents(b, c)).toBeLessThan(0);
    expect(b.cid < c.cid).toBe(true);
    // the author no longer breaks a tie: two events at one instant differ in CID, or are one event
    expect(compareEvents({ ...a, author: "ffffffff-ffff-7fff-bfff-ffffffffffff" as AuthorId }, a)).toBe(0);
  });

  it("filters by equality on cid, author, type and top-level data fields", () => {
    const changed = { ...envelope, data: { n: 1, s: "x", z: null, o: { k: 1 }, a: [1], f: false } };
    const event: Event = { ...changed, cid: eventCidOf(changed) };
    expect(matches(event)).toBe(true);
    expect(matches(event, {})).toBe(true);
    expect(matches(event, { cid: event.cid })).toBe(true);
    expect(matches(event, { cid: base.cid })).toBe(false);
    expect(matches(event, { cid: event.cid, type: "contact.petname" })).toBe(true);
    expect(matches(event, { cid: event.cid, type: "contact" })).toBe(false);
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
