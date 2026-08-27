import { describe, expect, it } from "vitest";
import { fill } from "../src/template.js";

describe("fill", () => {
  it("escapes, passes raw, walks sections", () => {
    const view = { t: "a<b", body: "<p>x</p>", files: [{ path: "a" }, { path: "b" }], card: { did: "did:key:z" }, none: "" };
    expect(fill("{{t}}|{{{body}}}|{{#files}}[{{path}}]{{/files}}|{{#card}}{{did}}{{/card}}|{{^none}}empty{{/none}}|{{missing}}", view)).toBe(
      "a&lt;b|<p>x</p>|[a][b]|did:key:z|empty|",
    );
  });
  it("handles {{.}}, dotted paths, nesting and string sections", () => {
    expect(fill("{{#tags}}<{{.}}>{{/tags}} {{card.did}} {{#s}}[{{s}}]{{/s}}", { tags: ["x", "y"], card: { did: "d" }, s: "v" })).toBe("<x><y> d [v]");
    expect(fill("{{#a}}{{#a}}{{b}}{{/a}}{{/a}}", { a: { b: 1 } })).toBe("1");
  });
  it("rejects a stray or unclosed tag", () => {
    expect(() => fill("{{/x}}", {})).toThrow(/unexpected/);
    expect(() => fill("{{#x}}", {})).toThrow(/unclosed/);
  });
});
