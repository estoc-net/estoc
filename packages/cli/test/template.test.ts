import { describe, expect, it } from "vitest";
import { fill } from "../src/template.js";

describe("fill", () => {
  it("escapes a double-brace value, passes a triple-brace one raw, and walks sections and inverted sections", () => {
    const view = { t: "a<b", body: "<p>x</p>", files: [{ path: "a" }, { path: "b" }], card: { did: "did:key:z" }, none: "" };
    expect(fill("{{t}}|{{{body}}}|{{#files}}[{{path}}]{{/files}}|{{#card}}{{did}}{{/card}}|{{^none}}empty{{/none}}|{{missing}}", view)).toBe(
      "a&lt;b|<p>x</p>|[a][b]|did:key:z|empty|",
    );
  });
  it("resolves {{.}}, dotted paths, nested sections and string sections", () => {
    expect(fill("{{#tags}}<{{.}}>{{/tags}} {{card.did}} {{#s}}[{{s}}]{{/s}}", { tags: ["x", "y"], card: { did: "d" }, s: "v" })).toBe("<x><y> d [v]");
    expect(fill("{{#a}}{{#a}}{{b}}{{/a}}{{/a}}", { a: { b: 1 } })).toBe("1");
  });
  it("keeps a value inside the attribute it was laid into, whichever quote the template used", () => {
    const title = `a' onmouseover='x" onfocus="y`;
    const html = fill(`<p title='{{title}}' lang="{{title}}">{{title}}</p>`, { title });
    expect(html).not.toMatch(/['"] on(mouseover|focus)=/);
    expect(html.match(/&#39;/g)).toHaveLength(6);
    expect(html.match(/&quot;/g)).toHaveLength(6);
  });
  it("rejects a stray or unclosed tag", () => {
    expect(() => fill("{{/x}}", {})).toThrow(/Unopened section/);
    expect(() => fill("{{#x}}", {})).toThrow(/Unclosed section/);
  });
});
