import type { IndexJson } from "@estoc/folder-object";

/** The type format URI this package speaks (folder-object formats/post-1.0.md). */
export const POST_FORMAT = "https://estoc.dev/post/1.0";

/** The vocabulary of a post, read out of its index (formats/post-1.0.md §1). */
export interface PostMeta {
  id: string;
  content: { mediaType: string; path: string } | { mediaType: string; text: string };
  title?: string;
  summary?: string;
  /** RFC 3339 */
  published?: string;
  /** RFC 3339; absent means equal to `published`. */
  updated?: string;
  tags: string[];
  /** BCP 47 */
  language?: string;
}

export interface PostIssue {
  member: string;
  message: string;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;

/** Does this index declare itself a post? Says nothing about whether it is a well-formed one. */
export function isPost(meta: IndexJson): boolean {
  return meta.format === POST_FORMAT;
}

/**
 * Check the vocabulary contract (formats/post-1.0.md §1). The structural
 * layer is assumed already parsed (`format`, `id`, the shape of `content`).
 * Returns every violation; an empty list means a well-formed post.
 */
export function validatePost(meta: IndexJson): PostIssue[] {
  const issues: PostIssue[] = [];
  if (!isPost(meta)) {
    issues.push({ member: "format", message: `not a post/1.0 object: ${meta.format}` });
    return issues;
  }
  if (meta.content === undefined) issues.push({ member: "content", message: "a post requires content" });
  else if (!meta.content.mediaType.startsWith("text/")) {
    issues.push({ member: "content", message: `mediaType must be a text markup type, got ${meta.content.mediaType}` });
  }
  for (const member of ["title", "summary", "language"] as const) {
    const v = meta[member];
    if (v !== undefined && typeof v !== "string") issues.push({ member, message: "must be a string" });
  }
  for (const member of ["published", "updated"] as const) {
    const v = meta[member];
    if (v === undefined) continue;
    if (typeof v !== "string" || !RFC3339.test(v)) issues.push({ member, message: "must be an RFC 3339 date-time" });
  }
  const tags = meta["tags"];
  if (tags !== undefined && !(Array.isArray(tags) && tags.every((t) => typeof t === "string"))) {
    issues.push({ member: "tags", message: "must be an array of strings" });
  }
  const language = meta["language"];
  if (typeof language === "string" && !BCP47.test(language)) {
    issues.push({ member: "language", message: "must be a BCP 47 tag" });
  }
  if (meta["objects"] !== undefined) issues.push({ member: "objects", message: "reserved; writers must not emit it" });
  return issues;
}

export class InvalidPostError extends Error {
  constructor(public readonly issues: PostIssue[]) {
    super(issues.map((i) => `${i.member}: ${i.message}`).join("; "));
    this.name = "InvalidPostError";
  }
}

/**
 * Read the vocabulary out of an index. Needs no bytes — only the index —
 * so it serves a host that holds the skeleton of a post whose body has not
 * arrived. Throws InvalidPostError on a contract violation.
 */
export function readPost(meta: IndexJson): PostMeta {
  const issues = validatePost(meta);
  if (issues.length) throw new InvalidPostError(issues);
  const post: PostMeta = { id: meta.id, content: meta.content!, tags: [] };
  const str = (m: string): string | undefined => (typeof meta[m] === "string" ? (meta[m] as string) : undefined);
  const title = str("title");
  if (title !== undefined) post.title = title;
  const summary = str("summary");
  if (summary !== undefined) post.summary = summary;
  const published = str("published");
  if (published !== undefined) post.published = published;
  const updated = str("updated");
  if (updated !== undefined) post.updated = updated;
  const language = str("language");
  if (language !== undefined) post.language = language;
  if (Array.isArray(meta["tags"])) post.tags = meta["tags"] as string[];
  return post;
}
