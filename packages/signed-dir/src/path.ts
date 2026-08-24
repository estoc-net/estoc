/** Split a `/`-separated relative path, rejecting anything unsafe. */
export function segmentsOf(path: string): string[] {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length === 0) {
    throw new Error("empty path");
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`unsafe path segment in ${path}`);
    }
  }
  return segments;
}

/** Reject entry names a verified tree must never contain. */
export function checkName(name: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/")) {
    throw new Error(`invalid entry name: ${JSON.stringify(name)}`);
  }
}
