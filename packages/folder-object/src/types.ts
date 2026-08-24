import type { TreeFiles } from "@estoc/signed-dir";

/** A fact: relative path → bytes. Re-exported from signed-dir for callers. */
export type { TreeFiles };

/** The structural members of index.json (spec §3.1); vocabulary members ride along untyped. */
export interface IndexJson {
  format: string;
  id: string;
  content?: { mediaType: string; path: string } | { mediaType: string; text: string };
  [member: string]: unknown;
}

/** An object: its index plus its canonical tree (`index.json` + `files/…`). */
export interface FolderObject {
  meta: IndexJson;
  /** The canonical tree, exactly the paths that enter the root hash. */
  tree: TreeFiles;
}

/** A bundle: `object/…` plus an optional `card.jws` (spec §5). */
export interface Bundle {
  object: FolderObject;
  card?: string;
}

/** Which layer rejected the tree (spec §8). */
export type MalformedLayer = "format" | "closure";

export class MalformedObjectError extends Error {
  constructor(
    public readonly layer: MalformedLayer,
    message: string,
  ) {
    super(`malformed object (${layer} layer): ${message}`);
    this.name = "MalformedObjectError";
  }
}
