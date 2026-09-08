import { describe, expect, it } from "vitest";

import { InvalidJson, MAX_DEPTH, canonicalText, canonicalize, forbiddenIn, parseStrict } from "../../src/v3/index.js";

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

// Spelled out so that no source escape stands between a test and the bytes it means.
const BS = String.fromCharCode(92);
/** The JSON escape `\uXXXX`, as text. */
const u = (hex4: string) => `${BS}u${hex4}`;
/** The string of these UTF-16 code units. */
const cp = (...units: number[]) => String.fromCharCode(...units);

/** The binary64 whose IEEE-754 bit pattern is `bits` (16 hex digits). */
function double(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

describe("RFC 8785 canonicalization", () => {
  it("serializes the appendix-B example to the RFC's exact bytes", () => {
    const input = `{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "${u("20ac")}$${u("000F")}${u("000a")}A'${u("0042")}${u("0022")}${u("005c")}${BS}${BS}${BS}"${BS}/",
      "literals": [null, true, false]
    }`;
    const expected =
      "7b226c69746572616c73223a5b6e756c6c2c747275652c66616c73655d2c226e756d62657273223a5b333333333333" +
      "3333332e333333333333332c31652b33302c342e352c302e3030322c31652d32375d2c22737472696e67223a22e282ac" +
      "245c75303030665c6e4127425c225c5c5c5c5c222f227d";
    const bytes = canonicalize(parseStrict(input));
    expect(hex(bytes)).toBe(expected);
    expect(text(bytes)).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],` +
        `"string":"€$${u("000f")}${BS}nA'B${BS}"${BS}${BS}${BS}${BS}${BS}"/"}`
    );
  });

  it("sorts member names by UTF-16 code units, as the RFC's section 3.2.3 example does", () => {
    const input = `{
      "${u("20ac")}": "Euro Sign",
      "${BS}r": "Carriage Return",
      "${u("000a")}": "Newline",
      "1": "One",
      "${u("0080")}": "Control${u("007f")}",
      "${u("d83d")}${u("de02")}": "Smiley",
      "${u("00f6")}": "Latin Small Letter O With Diaeresis",
      "${u("fb33")}": "Hebrew Letter Dalet With Dagesh",
      "</script>": "Browser Challenge"
    }`;
    // U+007F and U+0080 are not escaped: only U+0000–U+001F are (RFC 8785 §3.2.2.2)
    expect(text(canonicalize(parseStrict(input)))).toBe(
      `{"${BS}n":"Newline","${BS}r":"Carriage Return","1":"One","</script>":"Browser Challenge",` +
        `"${cp(0x80)}":"Control${cp(0x7f)}","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",` +
        `"😂":"Smiley","${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`
    );
  });

  it("writes numbers in ECMAScript Number::toString form (the RFC's appendix-B table)", () => {
    const table: [string, string][] = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ];
    for (const [bits, expected] of table) {
      expect(canonicalText(double(bits)), bits).toBe(expected);
    }
    expect(() => canonicalText(double("7fffffffffffffff"))).toThrow(InvalidJson); // NaN
    expect(() => canonicalText(double("7ff0000000000000"))).toThrow(InvalidJson); // Infinity
    expect(() => canonicalText(-Infinity)).toThrow(InvalidJson);
  });

  it("escapes as JSON.stringify does: only the quote, the backslash and U+0000–U+001F", () => {
    expect(canonicalText(`${cp(0, 0x1f, 0x7f, 0x80)}"${BS}/`)).toBe(
      `"${u("0000")}${u("001f")}${cp(0x7f, 0x80)}${BS}"${BS}${BS}/"`
    );
    expect(canonicalText(cp(8, 12, 10, 13, 9))).toBe(`"${BS}b${BS}f${BS}n${BS}r${BS}t"`);
    expect(canonicalText("😂")).toBe('"😂"');
    expect(hex(canonicalize("€"))).toBe("22e282ac22");
  });

  it("emits no whitespace, keeps array order and recurses", () => {
    expect(canonicalText({ b: [3, { z: 1, a: [] }, "x"], a: {} })).toBe('{"a":{},"b":[3,{"a":[],"z":1},"x"]}');
    expect(canonicalText([])).toBe("[]");
    expect(canonicalText(null)).toBe("null");
    expect(canonicalText(true)).toBe("true");
  });

  it("refuses what is not I-JSON", () => {
    const bad: [string, unknown][] = [
      ["undefined", undefined],
      ["an undefined member", { a: undefined }],
      ["an undefined element", [undefined]],
      ["a bigint", 1n],
      ["a function", () => 1],
      ["a symbol", Symbol("s")],
      ["NaN", NaN],
      ["Infinity", Infinity],
      ["a Date", new Date(0)],
      ["a Map", new Map()],
      ["a Uint8Array", new Uint8Array(1)],
      ["a class instance", new (class Foo {})()],
      ["a lone high surrogate", cp(0xd83d)],
      ["a lone low surrogate", `x${cp(0xde02)}`],
      ["a lone surrogate in a member name", { [cp(0xd800)]: 1 }],
      ["a noncharacter U+FDD0", cp(0xfdd0)],
      ["a noncharacter U+FDEF in a member name", { [cp(0xfdef)]: 1 }],
      ["a noncharacter U+FFFE", `a${cp(0xfffe)}b`],
      ["a noncharacter U+FFFF", [cp(0xffff)]],
      ["a noncharacter U+1FFFE", cp(0xd83f, 0xdffe)],
      ["a noncharacter U+10FFFF", { x: cp(0xdbff, 0xdfff) }],
    ];
    for (const [what, value] of bad) {
      expect(() => canonicalize(value), what).toThrow(InvalidJson);
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = [cycle];
    expect(() => canonicalize(cycle)).toThrow(/cycle/);
    let deep: unknown = 1;
    for (let i = 0; i < MAX_DEPTH + 1; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(/deeper/);
    let ok: unknown = 1;
    for (let i = 0; i < MAX_DEPTH; i++) ok = [ok];
    expect(() => canonicalize(ok)).not.toThrow();
  });

  it("keeps what I-JSON allows next to a noncharacter", () => {
    expect(canonicalText(cp(0xfdcf, 0xfdf0, 0xfffd))).toBe(`"${cp(0xfdcf, 0xfdf0, 0xfffd)}"`);
    expect(canonicalText(cp(0xdbff, 0xdffd))).toBe(`"${cp(0xdbff, 0xdffd)}"`); // U+10FFFD, last non-noncharacter
    expect(canonicalText("😂")).toBe('"😂"');
    expect(forbiddenIn("plain")).toBeNull();
    expect(forbiddenIn(cp(0xfdd0))).toBe("noncharacter U+FDD0");
    expect(forbiddenIn(cp(0xdbff, 0xdfff))).toBe("noncharacter U+10FFFF");
    expect(forbiddenIn(cp(0xde02))).toBe("unpaired surrogate U+DE02");
  });

  it("does not normalize Unicode and writes -0 as 0", () => {
    const composed = cp(0xe9); // é
    const decomposed = cp(0x65, 0x301); // e + combining acute
    expect(canonicalText(composed)).toBe(`"${composed}"`);
    expect(canonicalText(decomposed)).toBe(`"${decomposed}"`);
    expect(canonicalText(-0)).toBe("0");
    expect(canonicalText({ a: -0 })).toBe('{"a":0}');
  });
});

describe("strict parsing", () => {
  it("reads RFC 8259 text: every escape, nesting, whitespace, exponents", () => {
    const escapes = `${u("0041")}${u("d83d")}${u("de02")}${BS}/${BS}b${BS}f${BS}n${BS}r${BS}t${BS}"${BS}${BS}`;
    const input = `${cp(0x20, 9, 13, 10)}{"a" : [ 1 , -2.5e+3 , 0 , -0 , 1E-2 , true , false , null , "${escapes}" ] , "b" : { } } `;
    expect(parseStrict(input)).toEqual({
      a: [1, -2500, 0, -0, 0.01, true, false, null, `A😂/${cp(8, 12, 10, 13, 9)}"${BS}`],
      b: {},
    });
    expect(parseStrict(utf8.encode('"€😂"'))).toBe("€😂");
    expect(parseStrict(`"${u("d83d")}${u("de02")}${u("fdcf")}${u("fdf0")}${u("fffd")}"`)).toBe(cp(0xd83d, 0xde02, 0xfdcf, 0xfdf0, 0xfffd));
    expect(parseStrict(new Uint8Array([0x22, 0xf4, 0x8f, 0xbf, 0xbd, 0x22]))).toBe(cp(0xdbff, 0xdffd)); // U+10FFFD
    expect(parseStrict("[]")).toEqual([]);
    expect(parseStrict("12345678901234567890")).toBe(12345678901234567000);
    expect(parseStrict("1e308")).toBe(1e308);
    const proto = parseStrict('{"__proto__": 1, "constructor": 2}') as Record<string, unknown>;
    expect(Object.hasOwn(proto, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(proto.constructor).toBe(2);
    expect(Object.keys(proto)).toEqual(["__proto__", "constructor"]);
  });

  it("refuses a duplicate member, an unpaired surrogate and a number outside binary64", () => {
    const bad: [string, string | Uint8Array][] = [
      ["duplicate member", '{"a":1,"a":1}'],
      ["duplicate member, nested", '{"x":[{"a":1,"b":2,"a":3}]}'],
      ["duplicate member spelled differently", `{"${u("0061")}":1,"a":2}`],
      ["lone high surrogate escape", `"${u("d800")}"`],
      ["lone low surrogate escape", `"${u("dc00")}"`],
      ["high surrogate escape then text", `"${u("d800")}x"`],
      ["high surrogate escape then high", `"${u("d800")}${u("d800")}"`],
      ["lone surrogate in a string", `"${cp(0xd83d)}"`],
      ["lone surrogate in a name", `{"${cp(0xdc00)}":1}`],
      ["noncharacter escape U+FDD0", `"${u("fdd0")}"`],
      ["noncharacter escape U+FFFE in a name", `{"${u("fffe")}":1}`],
      ["noncharacter escape pair U+10FFFF", `"${u("dbff")}${u("dfff")}"`],
      ["noncharacter escape pair U+1FFFE", `{"x":["${u("d83f")}${u("dffe")}"]}`],
      ["raw noncharacter U+FDEF", `"${cp(0xfdef)}"`],
      ["raw noncharacter U+FFFF in a name", `{"${cp(0xffff)}":1}`],
      ["noncharacter U+FDD0 in UTF-8", new Uint8Array([0x22, 0xef, 0xb7, 0x90, 0x22])],
      ["noncharacter U+10FFFF in UTF-8", new Uint8Array([0x22, 0xf4, 0x8f, 0xbf, 0xbf, 0x22])],
      ["surrogate encoded in UTF-8", new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22])],
      ["invalid UTF-8", new Uint8Array([0x22, 0xc3, 0x22])],
      ["overlong UTF-8", new Uint8Array([0x22, 0xc0, 0xaf, 0x22])],
      ["a byte-order mark", new Uint8Array([0xef, 0xbb, 0xbf, 0x31])],
      ["1e400", "1e400"],
      ["-1e400", "-1e400"],
      ["NaN", "NaN"],
      ["Infinity", "Infinity"],
      ["-Infinity", "-Infinity"],
    ];
    for (const [what, input] of bad) {
      expect(() => parseStrict(input), what).toThrow(InvalidJson);
    }
  });

  it("refuses bad syntax where JSON.parse would too, and where it would not", () => {
    const bad = [
      "",
      " ",
      "01",
      "1.",
      ".5",
      "+1",
      "1e",
      "-",
      "0x10",
      "[1,]",
      "[,1]",
      '{"a":1,}',
      '{"a"}',
      "{a:1}",
      "{'a':1}",
      "[1] x",
      "[1] [2]",
      `"${BS}x41"`,
      `"${BS}u12"`,
      `"${BS}U0041"`,
      `"${BS}u004G"`,
      `"a${cp(10)}b"`,
      `"a${cp(0)}b"`,
      `"a${cp(0x1f)}b"`,
      '"unterminated',
      `"ends in a backslash${BS}`,
      "tru",
      "nul",
      "True",
      `${cp(0xa0)}[1]`,
      `${cp(12)}[1]`,
      `[1]${cp(0xfeff)}`,
      "/* c */ 1",
    ];
    for (const input of bad) {
      expect(() => parseStrict(input), JSON.stringify(input)).toThrow(InvalidJson);
    }
    expect(() => parseStrict("[".repeat(MAX_DEPTH + 1) + "]".repeat(MAX_DEPTH + 1))).toThrow(/deeper/);
    expect(() => parseStrict("[".repeat(MAX_DEPTH) + "]".repeat(MAX_DEPTH))).not.toThrow();
  });

  it("says where", () => {
    expect(() => parseStrict('{"a":1,"a":2}')).toThrow(/duplicate member "a" at offset 7/);
    expect(() => parseStrict("[1 2]")).toThrow(/at offset 3/);
  });

  it("two serializations with different member order or whitespace canonicalize to one byte string", () => {
    const a = utf8.encode(`{"type":"t","data":{"b":2,"a":[1, 2]},${cp(10)}  "roots":[]}`);
    const b = utf8.encode('{ "roots" : [ ] , "data" : { "a" : [ 1 , 2.0 ] , "b" : 2E0 } , "type" : "t" }');
    expect(hex(canonicalize(parseStrict(a)))).toBe(hex(canonicalize(parseStrict(b))));
    expect(text(canonicalize(parseStrict(a)))).toBe('{"data":{"a":[1,2],"b":2},"roots":[],"type":"t"}');
  });

  it("round-trips: canonical bytes parse back to a value with the same canonical bytes", () => {
    const value = { z: [1, { y: `€${cp(10)}😂`, x: null }], a: -0, m: 1e21, "": false };
    const once = canonicalize(value);
    expect(hex(canonicalize(parseStrict(once)))).toBe(hex(once));
  });
});
