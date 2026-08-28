/**
 * The wire encoding for a transport that carries text: JSON, with the two
 * shapes JSON has no word for tagged on the way out and untagged on the
 * way back. Bytes (`Uint8Array`) become `{"$bytes": base64}`, Maps become
 * `{"$map": [[k, v], …]}`; everything the daemon interface passes is
 * otherwise plain records. A message port needs none of this — structured
 * clone carries both — so the worker transport never calls it.
 */

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Uint8Array) {
      return { $bytes: toBase64(v) };
    }
    if (v instanceof Map) {
      return { $map: [...v] };
    }
    return v;
  });
}

export function decode(text: string): unknown {
  return JSON.parse(text, (_key, v: unknown) => {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1) {
        if (keys[0] === "$bytes" && typeof (v as { $bytes: unknown }).$bytes === "string") {
          return fromBase64((v as { $bytes: string }).$bytes);
        }
        if (keys[0] === "$map" && Array.isArray((v as { $map: unknown }).$map)) {
          return new Map((v as { $map: [unknown, unknown][] }).$map);
        }
      }
    }
    return v;
  });
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
