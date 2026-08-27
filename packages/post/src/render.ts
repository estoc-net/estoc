import { Marked, type Tokens } from "marked";
import { contentOf, type FolderObject } from "@estoc/folder-object";
import { readPost, type PostMeta } from "./format.js";

/**
 * The reference projection of a post: the object is the fact, this is one
 * way of looking at it. Pure — no network, no filesystem — and it yields
 * parts, never a page: the host owns the chrome (title tag, header, styles)
 * and composes these into whatever it is showing.
 */
export interface RenderOptions {
  /** Prefix for in-tree references (`files/…` → `${assetBase}/files/…`); default keeps them relative to the object root. */
  assetBase?: string;
}

export interface RenderedPost extends PostMeta {
  /** The body as an HTML fragment: raw HTML dropped, in-tree references rewritten against `assetBase`. */
  bodyHtml: string;
  /** Every in-tree path the body refers to, in order of first reference (present in the tree or not). */
  assets: string[];
}

/**
 * Resolve a body reference the way its media type does — against the body's
 * own location (spec §4: a `path` body lives at that path, a `text` body at
 * the root). Returns the in-tree path, or undefined for anything that is not
 * an in-tree reference (absolute URL, fragment, escapes the tree).
 */
export function resolveRef(ref: string, bodyPath: string | undefined): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("#")) return undefined;
  const target = ref.split(/[?#]/, 1)[0] ?? "";
  if (target === "") return undefined;
  const dir = bodyPath ? bodyPath.split("/").slice(0, -1) : [];
  const out: string[] = [...dir];
  for (const seg of target.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join("/") : undefined;
}

export function renderPost(object: FolderObject, options: RenderOptions = {}): RenderedPost {
  const post = readPost(object.meta);
  const content = contentOf(object);
  if (!content) throw new Error("post/1.0 requires content");
  if (content.mediaType !== "text/markdown") throw new Error(`unsupported body media type ${content.mediaType}`);
  const source = new TextDecoder().decode(content.bytes);
  const bodyPath = "path" in post.content ? post.content.path : undefined;
  const base = options.assetBase ? options.assetBase.replace(/\/$/, "") + "/" : "";
  const assets: string[] = [];
  const rewrite = (dest: string): string => {
    const resolved = resolveRef(dest, bodyPath);
    if (resolved === undefined) return dest;
    if (!assets.includes(resolved)) assets.push(resolved);
    return base + resolved;
  };

  const md = new Marked({
    gfm: true,
    renderer: {
      image({ href, text }: Tokens.Image) {
        return `<img src="${escapeAttr(rewrite(href))}" alt="${escapeAttr(text)}">`;
      },
      link({ href, tokens }: Tokens.Link) {
        return `<a href="${escapeAttr(rewrite(href))}">${this.parser.parseInline(tokens)}</a>`;
      },
      html: () => "",
    },
  });
  const bodyHtml = md.parse(source, { async: false }) as string;
  return { ...post, bodyHtml, assets };
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
