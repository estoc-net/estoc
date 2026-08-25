import { parse, renderHTML, type Image, type Link } from "@djot/djot";
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
  tag: string[];
  inLanguage?: string;
  /** Body as an HTML fragment. */
  bodyHtml: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function renderPost(object: FolderObject, options: RenderOptions = {}): RenderedPost {
  if (object.meta.format !== POST_FORMAT) throw new Error(`not a post/1.0 object: ${object.meta.format}`);
  const content = contentOf(object);
  if (!content) throw new Error("post/1.0 requires content");
  if (content.mediaType !== "text/x-djot") throw new Error(`unsupported body media type ${content.mediaType}`);
  const source = new TextDecoder().decode(content.bytes);
  const base = options.assetBase ? options.assetBase.replace(/\/$/, "") + "/" : "";
  const rewrite = (dest: string | undefined): string | undefined =>
    dest && dest.startsWith("files/") ? base + dest : dest;

  const doc = parse(source, { warn: () => {} });
  const bodyHtml = renderHTML(doc, {
    overrides: {
      image: (node: Image, r) => {
        const alt = node.children.map((c) => ("text" in c ? c.text : "")).join("");
        const src = rewrite(node.destination) ?? "";
        return `<img src="${r.escapeAttribute(src)}" alt="${r.escapeAttribute(alt)}">`;
      },
      link: (node: Link, r) => {
        const href = rewrite(node.destination) ?? "";
        return `<a href="${r.escapeAttribute(href)}">${r.renderChildren(node)}</a>`;
      },
      raw_block: () => "",
      raw_inline: () => "",
    },
  });

  const m = object.meta;
  const result: RenderedPost = {
    tag: Array.isArray(m.tag) ? m.tag.filter((t): t is string => typeof t === "string") : [],
    bodyHtml,
  };
  const title = str(m.name);
  if (title !== undefined) result.title = title;
  const summary = str(m.summary);
  if (summary !== undefined) result.summary = summary;
  const published = str(m.published);
  if (published !== undefined) result.published = published;
  const updated = str(m.updated);
  if (updated !== undefined) result.updated = updated;
  const lang = str(m.inLanguage);
  if (lang !== undefined) result.inLanguage = lang;
  return result;
}
