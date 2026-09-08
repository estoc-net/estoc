/**
 * The shape of `keystore.json`, version 3: one sealed seed, `seedJwe`,
 * under `version` 3, and nothing else — no derived-key registry, no key
 * cache. The JWE profile itself is `@estoc/keystore`'s; what the folder
 * checks before any write-producing open or import is the shape, so a
 * version-2 keystore with its `keys` cache, or a file that is not a
 * keystore at all, is refused in words.
 */

import { NotAVault } from "../errors.js";
import { isJsonObject } from "../json.js";
import { KEYSTORE_FILE } from "./layout.js";
import { VERSION, parseJsonFile } from "./config.js";

const MEMBERS = ["version", "seedJwe"] as const;
const JWE_MEMBERS = ["protected", "iv", "ciphertext", "tag"] as const;
/** Compact JWE serialization: five base64url parts. */
const COMPACT_JWE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Check `bytes` are a version-3 keystore by shape: a JSON object with
 * exactly `version` 3 and `seedJwe`, the latter a compact JWE string —
 * what `@estoc/keystore` writes — or the JSON serialization of one, with
 * exactly `protected`, `iv`, `ciphertext` and `tag`. Throws `NotAVault`
 * naming `path`. The seed is not opened here.
 */
export function checkKeystore(bytes: Uint8Array, path = KEYSTORE_FILE): void {
  const value = parseJsonFile(bytes, path);
  if (!isJsonObject(value)) throw new NotAVault(`${path} is not a JSON object`);
  for (const member of MEMBERS) {
    if (!Object.hasOwn(value, member)) throw new NotAVault(`${path} has no ${JSON.stringify(member)}`);
  }
  const extra = Object.keys(value).filter((k) => !(MEMBERS as readonly string[]).includes(k));
  if (extra.length > 0) {
    throw new NotAVault(`${path} has a member version ${VERSION} does not define: ${extra.map((k) => JSON.stringify(k)).join(", ")}${extra.includes("keys") ? " (a derived-key cache belongs to no version-3 vault)" : ""}`);
  }
  if (value["version"] !== VERSION) throw new NotAVault(`${path}: version ${JSON.stringify(value["version"])} is not ${VERSION}`);
  const jwe = value["seedJwe"];
  if (typeof jwe === "string") {
    if (!COMPACT_JWE.test(jwe)) throw new NotAVault(`${path}: seedJwe is not a compact JWE`);
    return;
  }
  if (!isJsonObject(jwe)) throw new NotAVault(`${path}: seedJwe is neither a compact JWE nor a JWE object`);
  for (const member of JWE_MEMBERS) {
    if (typeof jwe[member] !== "string") throw new NotAVault(`${path}: seedJwe.${member} is not a string`);
  }
  const jweExtra = Object.keys(jwe).filter((k) => !(JWE_MEMBERS as readonly string[]).includes(k));
  if (jweExtra.length > 0) throw new NotAVault(`${path}: seedJwe has a member the profile does not define: ${jweExtra.map((k) => JSON.stringify(k)).join(", ")}`);
}
