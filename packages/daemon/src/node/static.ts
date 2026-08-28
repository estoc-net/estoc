import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** What the served index.html carries so the page knows the daemon is its own origin. */
export const DAEMON_META = '<meta name="estoc-daemon" content="same-origin">';

/**
 * The app as static files out of one directory: hashed assets cached for
 * good, everything else not at all, any path that is not a file gets
 * index.html (the app routes on the client). index.html is served with a
 * `<meta>` tag added so the page connects to this origin's socket rather
 * than starting a worker of its own.
 */
export function staticHandler(dir: string): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const root = path.resolve(dir);
  let index: Promise<Buffer> | null = null;
  const indexHtml = () => {
    index ??= readFile(path.join(root, "index.html"), "utf8").then((html) => {
      const marked = html.includes(DAEMON_META) ? html : html.replace(/<head>/i, `<head>${DAEMON_META}`);
      return Buffer.from(marked);
    });
    return index;
  };
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const file = path.join(root, pathname);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(404).end();
      return;
    }
    const ext = path.extname(file);
    const isFile = await stat(file).then((s) => s.isFile()).catch(() => false);
    if (!isFile || ext === ".html") {
      const body = await indexHtml();
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-cache", "content-length": body.length });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    const body = await readFile(file);
    const hashed = pathname.startsWith("/assets/");
    res.writeHead(200, {
      "content-type": TYPES[ext] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "content-length": body.length,
    });
    res.end(req.method === "HEAD" ? undefined : body);
  };
}
