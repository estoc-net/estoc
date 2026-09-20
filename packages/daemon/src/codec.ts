/**
 * The wire encoding for a transport that carries text: JSON, with the two
 * shapes JSON has no word for tagged on the way out and untagged on the
 * way back. Bytes (`Uint8Array`) become `{"$bytes": base64}`, Maps become
 * `{"$map": [[k, v], …]}`; everything the daemon interface passes is
 * otherwise plain records. A tag is an object of one key that starts with
 * `$`, and a plain record may be one too — a message body is whatever its
 * sender wrote — so every such record goes out with one more `$` on its
 * key and comes back with one fewer: a value crosses as the value it was,
 * whatever its keys. A message port needs none of this — structured clone
 * carries both — so the worker transport never calls it.
 */

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Uint8Array) {
      return { $bytes: toBase64(v) };
    }
    if (v instanceof Map) {
      return { $map: [...v] };
    }
    const key = soleKeyOf(v);
    if (key?.startsWith("$")) {
      return { [`$${key}`]: (v as Record<string, unknown>)[key] };
    }
    return v;
  });
}

/** `text` as the value that was encoded; throws for text that is no JSON or carries a tag that is not one. */
export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    const key = soleKeyOf(v);
    if (!key?.startsWith("$")) {
      return v;
    }
    const held = (v as Record<string, unknown>)[key];
    if (key.startsWith("$$")) {
      return { [key.slice(1)]: held };
    }
    if (key === "$bytes" && typeof held === "string") {
      return fromBase64(held);
    }
    if (key === "$map" && Array.isArray(held) && held.every((entry) => Array.isArray(entry) && entry.length === 2)) {
      return new Map(held as [unknown, unknown][]);
    }
    throw new SyntaxError(`${key} is no tag of this encoding, or does not hold what that tag holds`);
  });
}

function soleKeyOf(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return undefined;
  }
  const keys = Object.keys(v);
  return keys.length === 1 ? keys[0] : undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
