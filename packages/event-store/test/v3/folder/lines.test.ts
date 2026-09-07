import { describe, expect, it } from "vitest";

import {
  InvalidEvent,
  InvalidJson,
  acceptedLength,
  canonicalEventBytes,
  decodeLine,
  decodeSegment,
  encodeLines,
  endsClean,
  splitLines,
  text,
  utf8,
  type Event,
} from "../../../src/v3/index.js";
import { authorN, expectBytes, uuidv7At } from "../suite/helpers.js";

const A1 = authorN(1);
const A2 = authorN(2);
const ID = uuidv7At(Date.UTC(2026, 8, 7, 10), 0x1234abcd);
const EVENT = { eventId: ID, at: "2026-09-07T10:00:00.000Z", author: A1, type: "t", roots: [], data: { b: 1, a: "x" } } as unknown as Event;
/** the one spelling the folder stores (§2, VF-9) */
const CANONICAL = `{"at":"2026-09-07T10:00:00.000Z","author":"${A1}","data":{"a":"x","b":1},"eventId":"${ID}","roots":[],"type":"t"}`;

describe("lines (vault-folder.md §2, §6, §8, §11.5)", () => {
  it("splitLines finds each line's byte range, numbered from 1; an unterminated tail is not whole", () => {
    expect(splitLines(new Uint8Array(0))).toEqual([]);
    expect(splitLines(utf8("ab\ncd\n"))).toEqual([
      { n: 1, start: 0, end: 2, whole: true },
      { n: 2, start: 3, end: 5, whole: true },
    ]);
    expect(splitLines(utf8("ab\ncd"))).toEqual([
      { n: 1, start: 0, end: 2, whole: true },
      { n: 2, start: 3, end: 5, whole: false },
    ]);
    expect(splitLines(utf8("\n\nx"))).toEqual([
      { n: 1, start: 0, end: 0, whole: true },
      { n: 2, start: 1, end: 1, whole: true },
      { n: 3, start: 2, end: 3, whole: false },
    ]);
    expect(acceptedLength(utf8("ab\ncd"))).toBe(3);
    expect(acceptedLength(utf8("ab\ncd\n"))).toBe(6);
    expect(acceptedLength(utf8("abc"))).toBe(0);
    expect(endsClean(new Uint8Array(0))).toBe(true);
    expect(endsClean(utf8("ab\n"))).toBe(true);
    expect(endsClean(utf8("ab"))).toBe(false);
  });

  it("ES-10, VF-9: encodeLines writes each event's RFC 8785 bytes and one LF, and decodeLine reads exactly that back", () => {
    const bytes = encodeLines([EVENT]);
    expectBytes(bytes, utf8(`${CANONICAL}\n`));
    expectBytes(canonicalEventBytes(EVENT), utf8(CANONICAL));
    const decoded = decodeLine(utf8(CANONICAL), A1);
    expect(decoded.text).toBe(CANONICAL);
    expect(JSON.stringify(decoded.event)).toBe(CANONICAL);
    expect(Object.keys(decoded.event)).toEqual(["at", "author", "data", "eventId", "roots", "type"]);
  });

  it("VF-9: a line that is not the event's canonical bytes is damage, however valid its JSON", () => {
    const spellings = [
      JSON.stringify(EVENT), // compact, members in the writer's order
      `${CANONICAL} `, // trailing space
      ` ${CANONICAL}`,
      `${CANONICAL}\r`, // CRLF line ending
      JSON.stringify(JSON.parse(CANONICAL), null, 2).replace(/\n */g, ""), // pretty then squashed: spaces after colons
      CANONICAL.replace('"b":1', '"b":1.0'),
      CANONICAL.replace('"b":1', '"b":1e0'),
      CANONICAL.replace('"a":"x"', '"a":"\\u0078"'), // an escaped x
      "", // an empty line
    ];
    for (const line of spellings) {
      expect(() => decodeLine(utf8(line), A1), JSON.stringify(line)).toThrow();
    }
    expect(() => decodeLine(utf8(JSON.stringify(EVENT)), A1)).toThrow(InvalidEvent);
    expect(() => decodeLine(utf8(JSON.stringify(EVENT)), A1)).toThrow("not the event's RFC 8785 canonical bytes");
  });

  it("§11.5: bad UTF-8, bad JSON, a non-object, a bad envelope and a duplicate member are each damage with their own reason", () => {
    expect(() => decodeLine(new Uint8Array([0x7b, 0xff, 0x7d]), A1)).toThrow("not UTF-8");
    expect(() => decodeLine(utf8("{"), A1)).toThrow(InvalidJson);
    expect(() => decodeLine(utf8("[1]"), A1)).toThrow(InvalidEvent);
    expect(() => decodeLine(utf8('"text"'), A1)).toThrow(InvalidEvent);
    expect(() => decodeLine(utf8(CANONICAL.replace('"type":"t"', '"type":""')), A1)).toThrow(InvalidEvent);
    expect(() => decodeLine(utf8(CANONICAL.replace('"data":{"a":"x","b":1}', '"data":{"a":"x","a":1}')), A1)).toThrow(InvalidJson);
    expect(() => decodeLine(utf8(CANONICAL.replace("Z\"", "\"")), A1)).toThrow(InvalidEvent);
  });

  it("VF-2: the path confirms authorship and never supplies it — a canonical line under another author's directory is damage", () => {
    expect(() => decodeLine(utf8(CANONICAL), A2)).toThrow(`author ${A1} in a segment of ${A2}`);
    expect(decodeLine(utf8(CANONICAL), A1).event.author).toBe(A1);
  });

  it("VF-10: decodeSegment reports a fragment by position and never joins it with the next line; every other line stands on its own", () => {
    const good = `${CANONICAL}\n`;
    const other = CANONICAL.replace(ID, uuidv7At(Date.UTC(2026, 8, 7, 11), 0x1));
    const bytes = utf8(`${good}{"at":"2026-09-07T10:00:00.000Z","aut`);
    const read = decodeSegment(bytes, "events/x/s.jsonl", A1);
    expect(read.events.map((e) => e.n)).toEqual([1]);
    expect(read.events[0]?.end).toBe(good.length);
    expect(read.accepted).toBe(good.length);
    expect(read.damaged).toHaveLength(1);
    expect(read.damaged[0]?.where).toBe("events/x/s.jsonl:2");
    expect(read.damaged[0]?.error).toBe("incomplete final fragment");
    expect(text(read.damaged[0]?.bytes as Uint8Array)).toBe('{"at":"2026-09-07T10:00:00.000Z","aut');
    // the fragment terminated by a heal, then a good line after it: three lines, the middle one damage of another kind
    const healed = utf8(`${good}{"at":"2026-09-07T10:00:00.000Z","aut\n${other}\n`);
    const again = decodeSegment(healed, "s", A1);
    expect(again.events.map((e) => e.n)).toEqual([1, 3]);
    expect(again.damaged.map((d) => d.where)).toEqual(["s:2"]);
    expect(again.damaged[0]?.error).not.toBe("incomplete final fragment");
    expect(again.accepted).toBe(healed.length);
    // an empty line is damage too, not skipped: the record is not canonical bytes
    const blank = decodeSegment(utf8(`\n${good}`), "s", A1);
    expect(blank.events.map((e) => e.n)).toEqual([2]);
    expect(blank.damaged.map((d) => d.where)).toEqual(["s:1"]);
  });

  it("decodeSegment reads only the lines starting within [from, to) when asked, keeping their numbers", () => {
    const other = CANONICAL.replace(ID, uuidv7At(Date.UTC(2026, 8, 7, 11), 0x1));
    const bytes = utf8(`${CANONICAL}\n${other}\n`);
    const tail = decodeSegment(bytes, "s", A1, CANONICAL.length + 1);
    expect(tail.events.map((e) => e.n)).toEqual([2]);
    expect(tail.events[0]?.end).toBe(bytes.length);
    const head = decodeSegment(bytes, "s", A1, 0, CANONICAL.length + 1);
    expect(head.events.map((e) => e.n)).toEqual([1]);
  });
});
