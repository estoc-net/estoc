import { describe, expect, it } from "vitest";
import { readObject } from "@estoc/folder-object";
import { InvalidPostError, POST_FORMAT, isPost, readPost, renderPost, resolveRef, validatePost } from "../src/index.js";

const enc = (s: string) => new TextEncoder().encode(s);
const ID = "01a03110-7c1e-7b3a-9f42-3d5e8a1b2c04";

function post(extra: Record<string, unknown>, body = "hello", files: Record<string, string> = {}) {
  const index = { format: POST_FORMAT, id: ID, content: { mediaType: "text/markdown", path: "files/body.md" }, ...extra };
  const tree: Record<string, Uint8Array> = { "index.json": enc(JSON.stringify(index)), "files/body.md": enc(body) };
  for (const [p, s] of Object.entries(files)) tree[p] = enc(s);
  return readObject(tree);
}

describe("vocabulary", () => {
  it("recognises and validates a post", () => {
    const o = post({ title: "T", summary: "S", published: "2026-08-24T10:30:00Z", tags: ["a"], language: "zh-Hant" });
    expect(isPost(o.meta)).toBe(true);
    expect(validatePost(o.meta)).toEqual([]);
    expect(readPost(o.meta)).toMatchObject({ id: ID, title: "T", summary: "S", tags: ["a"], language: "zh-Hant" });
  });
  it("defaults tags to [] and leaves absent members absent", () => {
    const p = readPost(post({}).meta);
    expect(p.tags).toEqual([]);
    expect("title" in p).toBe(false);
  });
  it("reports every violation", () => {
    const meta = { ...post({}).meta, title: 1, published: "yesterday", tags: "x", language: "not a tag!", objects: {} };
    expect(validatePost(meta).map((i) => i.member).sort()).toEqual(["language", "objects", "published", "tags", "title"]);
    expect(() => readPost(meta)).toThrow(InvalidPostError);
  });
  it("rejects a non-post and a post without content", () => {
    expect(validatePost({ format: "https://example/x", id: ID })[0]?.member).toBe("format");
    expect(validatePost({ format: POST_FORMAT, id: ID })[0]?.member).toBe("content");
    expect(validatePost({ format: POST_FORMAT, id: ID, content: { mediaType: "image/png", path: "files/a" } })[0]?.member).toBe("content");
  });
});

describe("resolveRef", () => {
  it("resolves against the body's directory and refuses to leave the tree", () => {
    expect(resolveRef("a.jpg", "files/body.md")).toBe("files/a.jpg");
    expect(resolveRef("./img/a.jpg?x#y", "files/body.md")).toBe("files/img/a.jpg");
    expect(resolveRef("../index.json", "files/body.md")).toBe("index.json");
    expect(resolveRef("../../etc", "files/body.md")).toBeUndefined();
    expect(resolveRef("https://x/y", "files/body.md")).toBeUndefined();
    expect(resolveRef("#frag", "files/body.md")).toBeUndefined();
    expect(resolveRef("files/a.jpg", undefined)).toBe("files/a.jpg");
  });
});

describe("renderPost", () => {
  it("yields parts: vocabulary, body fragment, assets", () => {
    const r = renderPost(post({ title: "T" }, "# H\n\n![p](a.jpg) [l](b.md) [l2](a.jpg) [x](https://e/) <b>raw</b>", { "files/a.jpg": "" }));
    expect(r.title).toBe("T");
    expect(r.bodyHtml).toContain('<img src="files/a.jpg" alt="p">');
    expect(r.bodyHtml).toContain('<a href="files/b.md">');
    expect(r.bodyHtml).toContain('<a href="https://e/">');
    expect(r.bodyHtml).not.toContain("<b>");
    expect(r.assets).toEqual(["files/a.jpg", "files/b.md"]);
  });
  it("prefixes in-tree references with assetBase", () => {
    const r = renderPost(post({}, "![p](a.jpg)"), { assetBase: "object/" });
    expect(r.bodyHtml).toContain('src="object/files/a.jpg"');
    expect(r.assets).toEqual(["files/a.jpg"]);
  });
  it("refuses a non-markdown body", () => {
    const o = post({});
    o.meta.content = { mediaType: "text/plain", path: "files/body.md" };
    expect(() => renderPost(o)).toThrow(/media type/);
  });
});
