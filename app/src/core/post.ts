import { Marked, type Tokens } from "marked";
import { contentOf, type FolderObject } from "@estoc/folder-object";

/**
 * post/1.0 projection. The object is the fact; this is one way of looking
 * at it — the app's. Pure: no network, no filesystem, raw HTML dropped.
 */
export const POST_FORMAT = "https://estoc.dev/post/1.0";

export interface RenderOptions {
  /** Prefix for in-tree references (`files/…` → `${assetBase}/files/…`); default keeps them relative. */
  assetBase?: string;
}

export interface RenderedPost {
  title?: string;
  summary?: string;
  published?: string;
  updated?: string;
  tags: string[];
  language?: string;
  /** Body as an HTML fragment. */
  bodyHtml: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Resolve a body reference the way its media type does — against the body's
 * own location (spec §4: a `path` body lives at that path, a `text` body at
 * the root). Returns the in-tree path, or undefined for anything that is not
 * an in-tree reference (absolute URL, escapes the tree).
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
  if (object.meta.format !== POST_FORMAT) throw new Error(`not a post/1.0 object: ${object.meta.format}`);
  const content = contentOf(object);
  if (!content) throw new Error("post/1.0 requires content");
  if (content.mediaType !== "text/markdown") throw new Error(`unsupported body media type ${content.mediaType}`);
  const source = new TextDecoder().decode(content.bytes);
  const c = object.meta.content;
  const bodyPath = c && "path" in c ? c.path : undefined;
  const base = options.assetBase ? options.assetBase.replace(/\/$/, "") + "/" : "";
  const rewrite = (dest: string): string => {
    const resolved = resolveRef(dest, bodyPath);
    return resolved === undefined ? dest : base + resolved;
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

  const m = object.meta;
  const result: RenderedPost = {
    tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [],
    bodyHtml,
  };
  const title = str(m.title);
  if (title !== undefined) result.title = title;
  const summary = str(m.summary);
  if (summary !== undefined) result.summary = summary;
  const published = str(m.published);
  if (published !== undefined) result.published = published;
  const updated = str(m.updated);
  if (updated !== undefined) result.updated = updated;
  const lang = str(m.language);
  if (lang !== undefined) result.language = lang;
  return result;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
