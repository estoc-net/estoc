/**
 * The smallest useful slice of Mustache, for laying rendered parts into a
 * host's page: `{{key}}` escaped, `{{{key}}}` raw, `{{#key}}…{{/key}}` once
 * per item of an array or once if truthy, `{{^key}}…{{/key}}` if absent or
 * empty, `{{.}}` the current item, dotted paths. Nothing else — partials,
 * lambdas and delimiters are not a thing here.
 */
export type View = unknown;

export function fill(template: string, view: View): string {
  return render(template, [view]);
}

const TAG = /\{\{(\{\s*[^}]+?\s*\}|[#^/]?\s*[^}]+?)\s*\}\}/g;

function lookup(stack: View[], path: string): unknown {
  if (path === ".") return stack[stack.length - 1];
  const [head, ...rest] = path.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== null && typeof frame === "object" && head! in (frame as object)) {
      let v: unknown = (frame as Record<string, unknown>)[head!];
      for (const k of rest) v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      return v;
    }
  }
  return undefined;
}

function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== "";
}

function render(template: string, stack: View[]): string {
  let out = "";
  let pos = 0;
  TAG.lastIndex = 0;
  for (;;) {
    TAG.lastIndex = pos;
    const m = TAG.exec(template);
    if (!m) return out + template.slice(pos);
    out += template.slice(pos, m.index);
    pos = m.index + m[0].length;
    const tag = m[1]!;
    if (tag.startsWith("{")) {
      out += str(lookup(stack, tag.slice(1, -1).trim()));
    } else if (tag.startsWith("#") || tag.startsWith("^")) {
      const name = tag.slice(1).trim();
      const end = findClose(template, pos, name);
      const inner = template.slice(pos, end.start);
      pos = end.end;
      const v = lookup(stack, name);
      if (tag.startsWith("^")) {
        if (!truthy(v)) out += render(inner, stack);
      } else if (Array.isArray(v)) {
        for (const item of v) out += render(inner, [...stack, item]);
      } else if (truthy(v)) {
        out += render(inner, [...stack, v]);
      }
    } else if (tag.startsWith("/")) {
      throw new Error(`unexpected {{${tag}}}`);
    } else {
      out += escape(str(lookup(stack, tag.trim())));
    }
  }
}

function findClose(template: string, from: number, name: string): { start: number; end: number } {
  const re = /\{\{([#^/])\s*([^}]+?)\s*\}\}/g;
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(template); m; m = re.exec(template)) {
    if (m[2] !== name) continue;
    if (m[1] === "/") depth--;
    else depth++;
    if (depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  throw new Error(`unclosed {{#${name}}}`);
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.join(", ") : String(v);
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
