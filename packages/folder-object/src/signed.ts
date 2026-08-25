import { readObject } from "./object.js";
import { MalformedObjectError, type FolderObject, type SignedObject, type TreeFiles } from "./types.js";

/**
 * A signed object on disk (spec §5):
 *
 *     object/     the canonical tree, verbatim
 *     card.jws    the card
 *
 * Anything else beside them is not part of the signed object and is
 * ignored when reading — a rendered page can sit next to `object/`.
 */
export function signedTree(object: FolderObject, card: string): TreeFiles {
  const out: TreeFiles = {};
  for (const [path, bytes] of Object.entries(object.tree)) out[`object/${path}`] = bytes;
  out["card.jws"] = new TextEncoder().encode(card);
  return out;
}

/**
 * Recognize what a mapping holds: a signed object (`object/index.json`,
 * with `card.jws` beside it) or a bare object (`index.json` at the root).
 * The card is absent for a bare object, or a signed layout that has none.
 */
export function readAny(mapping: TreeFiles): { object: FolderObject; card?: string } {
  if ("object/index.json" in mapping) {
    const inner: TreeFiles = {};
    for (const [path, bytes] of Object.entries(mapping)) {
      if (path.startsWith("object/")) inner[path.slice("object/".length)] = bytes;
    }
    const cardBytes = mapping["card.jws"];
    const object = readObject(inner);
    return cardBytes ? { object, card: new TextDecoder().decode(cardBytes).trim() } : { object };
  }
  if ("index.json" in mapping) return { object: readObject(mapping) };
  throw new MalformedObjectError("format", "neither object/index.json nor index.json found");
}

/** A signed object from a mapping; throws if there is no card. */
export function readSignedObject(mapping: TreeFiles): SignedObject {
  const { object, card } = readAny(mapping);
  if (card === undefined) throw new MalformedObjectError("format", "no card.jws: an object, not a signed one");
  return { object, card };
}
